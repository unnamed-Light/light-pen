use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, io::Write, path::Path};
mod extended;
pub use extended::{read_template, remove_template, save_template, templates, TemplateSummary};

const APP_ID: i32 = 0x4c50454e;
const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardDocument {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub elements: Vec<Value>,
}

fn numeric(v: &Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.abs() <= 1e9)
        .ok_or_else(|| format!("Повреждённое числовое поле: {key}."))
}
fn valid_color(value: Option<&Value>) -> bool {
    let Some(s) = value.and_then(Value::as_str) else {
        return false;
    };
    s == "transparent"
        || (s.len() == 7
            && s.starts_with('#')
            && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
}

pub fn validate(doc: &BoardDocument) -> Result<(), String> {
    if ![1, 2, 3].contains(&doc.schema_version) {
        return Err("Эта версия файла не поддерживается. Обновите Light Pen.".into());
    }
    if doc.id.is_empty()
        || doc.id.len() > 128
        || !doc
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || doc.title.chars().count() > 250
        || doc.revision > 9_007_199_254_740_991
        || doc.elements.len() > 100_000
    {
        return Err("Повреждена структура документа.".into());
    }
    let mut ids = HashSet::new();
    let mut point_count = 0usize;
    for el in &doc.elements {
        let id = el
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or("У объекта нет идентификатора.")?;
        if !ids.insert(id) {
            return Err("В документе повторяются идентификаторы объектов.".into());
        }
        let kind = el
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("У объекта нет типа.")?;
        extended::validate_extra(el, kind)?;
        for key in ["x", "y"] {
            numeric(el, key)?;
        }
        if el
            .get("createdAt")
            .and_then(Value::as_f64)
            .is_none_or(|n| !n.is_finite() || !(0.0..=1e15).contains(&n))
        {
            return Err("Повреждена дата объекта.".into());
        }
        let width = numeric(el, "width")?;
        let height = numeric(el, "height")?;
        let size = numeric(el, "strokeWidth")?;
        let opacity = numeric(el, "opacity")?;
        for key in ["bold", "italic", "locked"] {
            if el.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err("Повреждены свойства оформления.".into());
            }
        }
        if el.get("groupId").is_some_and(|v| {
            v.as_str().is_none_or(|s| {
                s.is_empty()
                    || s.len() > 128
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        }) {
            return Err("Повреждена группа.".into());
        }
        if el.get("textAlign").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| !["left", "center", "right"].contains(&s))
        }) {
            return Err("Повреждено выравнивание текста.".into());
        }
        for key in ["startBinding", "endBinding"] {
            if let Some(binding) = el.get(key) {
                if kind != "arrow"
                    || binding
                        .get("elementId")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.is_empty() || s.len() > 128)
                    || binding
                        .get("side")
                        .and_then(Value::as_str)
                        .is_none_or(|s| !["left", "right", "top", "bottom"].contains(&s))
                {
                    return Err("Повреждена привязка стрелки.".into());
                }
            }
        }
        if let Some(ink) = el.get("ink") {
            for (key, min, max) in [
                ("smoothing", 0.0, 100.0),
                ("stabilization", 0.0, 95.0),
                ("minWidth", 1.0, 100.0),
                ("pressure", 25.0, 200.0),
            ] {
                if !(min..=max).contains(&numeric(ink, key)?) {
                    return Err("Повреждены настройки пера.".into());
                }
            }
        }
        if width < 0.0
            || height < 0.0
            || size <= 0.0
            || size > 128.0
            || !(0.0..=1.0).contains(&opacity)
            || !valid_color(el.get("color"))
            || !valid_color(el.get("fill"))
        {
            return Err("Повреждены свойства объекта.".into());
        }
        match kind {
            "stroke" => {
                let points = el
                    .get("points")
                    .and_then(Value::as_array)
                    .filter(|p| !p.is_empty())
                    .ok_or("В штрихе нет точек.")?;
                point_count += points.len();
                if point_count > 2_000_000 {
                    return Err("В документе слишком много точек.".into());
                }
                for p in points {
                    let a = p
                        .as_array()
                        .filter(|a| a.len() == 4)
                        .ok_or("Повреждена точка штриха.")?;
                    if a.iter()
                        .any(|v| v.as_f64().is_none_or(|n| !n.is_finite() || n.abs() > 1e9))
                        || a[2].as_f64().is_none_or(|n| !(0.0..=1.0).contains(&n))
                        || a[3].as_f64().is_none_or(|n| n < 0.0)
                    {
                        return Err("Повреждены координаты или давление пера.".into());
                    }
                }
            }
            "text" | "sticky" | "frame" | "math" | "table" | "task" | "link" => {
                if el
                    .get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.chars().count() > 100_000)
                    || !(8.0..=256.0).contains(&numeric(el, "fontSize")?)
                {
                    return Err("Повреждён текст объекта.".into());
                }
            }
            "arrow" | "line" => {
                numeric(el, "endX")?;
                numeric(el, "endY")?;
            }
            "image" => {
                let data = el
                    .get("dataUrl")
                    .and_then(Value::as_str)
                    .ok_or("Нет данных изображения.")?;
                if ![
                    "data:image/png;base64,",
                    "data:image/jpeg;base64,",
                    "data:image/webp;base64,",
                ]
                .iter()
                .any(|p| data.starts_with(p))
                {
                    return Err("Неподдерживаемое изображение.".into());
                }
            }
            "rectangle" | "ellipse" | "diamond" => {}
            _ => return Err("Неизвестный тип объекта.".into()),
        }
    }
    Ok(())
}

pub fn atomic_save(
    path: &Path,
    doc: &BoardDocument,
    source_path: Option<&str>,
) -> Result<(), String> {
    validate(doc)?;
    let json = serde_json::to_string(doc).map_err(|e| e.to_string())?;
    if json.len() > MAX_JSON_BYTES {
        return Err("Документ превышает ограничение 64 МБ.".into());
    }
    let parent = path
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("Папка сохранения не существует.")?;
    let temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Не удалось создать временный файл: {e}"))?
        .into_temp_path();
    {
        let mut connection = Connection::open(&temp).map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "application_id", APP_ID)
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "user_version", doc.schema_version)
            .map_err(|e| e.to_string())?;
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("CREATE TABLE document (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO document VALUES (1, ?1)", [&json])
            .map_err(|e| e.to_string())?;
        let revision = doc.revision.to_string();
        let objects = doc.elements.len().to_string();
        for (key, value) in [
            ("title", doc.title.as_str()),
            ("documentId", doc.id.as_str()),
            ("updatedAt", doc.updated_at.as_str()),
            ("revision", revision.as_str()),
            ("objects", objects.as_str()),
        ] {
            tx.execute("INSERT INTO metadata VALUES (?1, ?2)", params![key, value])
                .map_err(|e| e.to_string())?;
        }
        if let Some(source) = source_path {
            tx.execute("INSERT INTO metadata VALUES ('sourcePath', ?1)", [source])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        connection.close().map_err(|(_, e)| e.to_string())?;
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temp)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| {
        format!(
            "Не удалось заменить файл. Предыдущая версия сохранена: {}",
            e.error
        )
    })?;
    Ok(())
}

pub fn read_document(path: &Path) -> Result<(BoardDocument, Option<String>), String> {
    let meta = fs::metadata(path).map_err(|e| format!("Не удалось открыть файл: {e}"))?;
    if !meta.is_file() || meta.len() > (MAX_JSON_BYTES as u64 + 16 * 1024 * 1024) {
        return Err("Файл слишком большой или не является документом.".into());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Файл не является доской Light Pen.")?;
    let app_id: i32 = connection
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(|_| "Повреждён заголовок файла.")?;
    if app_id != APP_ID {
        return Err("Файл не является доской Light Pen.".into());
    }
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if ![1, 2, 3].contains(&version) {
        return Err("Эта версия файла не поддерживается. Обновите Light Pen.".into());
    }
    let result: String = connection
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(|_| "Нарушена целостность файла.")?;
    if result != "ok" {
        return Err("Нарушена целостность файла.".into());
    }
    let length: usize = connection
        .query_row(
            "SELECT length(CAST(payload AS BLOB)) FROM document WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "В файле отсутствует доска.")?;
    if length > MAX_JSON_BYTES {
        return Err("Документ превышает ограничение 64 МБ.".into());
    }
    let json: String = connection
        .query_row("SELECT payload FROM document WHERE id=1", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let document: BoardDocument =
        serde_json::from_str(&json).map_err(|_| "Повреждена структура документа.")?;
    validate(&document)?;
    let source = connection
        .query_row(
            "SELECT value FROM metadata WHERE key=?1",
            params!["sourcePath"],
            |r| r.get(0),
        )
        .ok();
    Ok((document, source))
}

pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("Папка сохранения не существует.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    temp.persist(path)
        .map_err(|e| format!("Не удалось сохранить файл: {}", e.error))?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub document: Option<BoardDocument>,
    pub path: Option<String>,
    pub warning: Option<String>,
    pub needs_save: bool,
}

fn draft_path(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Неверный идентификатор черновика.".into());
    }
    Ok(root.join("drafts").join(format!("{id}.lightpen")))
}

pub fn persist_session(
    root: &Path,
    doc: &BoardDocument,
    source: Option<&str>,
) -> Result<(), String> {
    validate(doc)?;
    fs::create_dir_all(root.join("drafts")).map_err(|e| e.to_string())?;
    let draft = draft_path(root, &doc.id)?;
    let previous = read_document(&draft).ok().map(|(d, _)| d);
    if draft.exists() && read_document(&draft).is_ok() {
        fs::copy(&draft, draft.with_extension("previous.lightpen"))
            .map_err(|e| format!("Не удалось обновить резервный черновик: {e}"))?;
    }
    // Recovery precedes writing the user's target, so an unavailable target never
    // prevents crash recovery of the newest work.
    atomic_save(&draft, doc, source)?;
    // Point recovery to the fresh draft before optional historical archiving.
    atomic_bytes(
        &root.join("session.json"),
        serde_json::to_string(&serde_json::json!({"id":doc.id}))
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )?;
    if let Some(previous) = previous {
        if previous != *doc {
            let directory = version_directory(root, &doc.id)?;
            let newest = fs::read_dir(directory)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .split('-')
                        .next()?
                        .parse::<u128>()
                        .ok()
                })
                .max()
                .map(|n| (n / 1_000_000) as u64);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64;
            if newest.is_none_or(|stamp| now.saturating_sub(stamp) > 60_000) {
                save_checkpoint(root, &previous, false)?;
            }
        }
    }
    if let Some(path) = source {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err("Выберите полный путь к файлу.".into());
        }
        atomic_save(path, doc, None)?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub id: String,
    pub timestamp: u64,
    pub revision: u64,
    pub objects: usize,
    pub manual: bool,
    pub bytes: u64,
}
fn version_directory(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    draft_path(root, id)?;
    Ok(root.join("versions").join(id))
}
pub fn list_versions(root: &Path, id: &str) -> Result<Vec<DocumentVersion>, String> {
    let directory = version_directory(root, id)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut versions = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
    {
        let file = entry.path();
        if file.extension().is_none_or(|s| s != "lightpen") {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(timestamp) = name
            .split('-')
            .next()
            .and_then(|s| s.parse::<u128>().ok())
            .map(|n| (n / 1_000_000) as u64)
        else {
            continue;
        };
        if let Ok(connection) = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            let meta = |key: &str| -> Option<String> {
                connection
                    .query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
                        r.get(0)
                    })
                    .ok()
            };
            if meta("documentId").as_deref() != Some(id) {
                continue;
            }
            versions.push(DocumentVersion {
                id: name.clone(),
                timestamp,
                revision: meta("revision").and_then(|s| s.parse().ok()).unwrap_or(0),
                objects: meta("objects").and_then(|s| s.parse().ok()).unwrap_or(0),
                manual: name.contains("-manual"),
                bytes: entry.metadata().map_err(|e| e.to_string())?.len(),
            });
        }
    }
    versions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(versions)
}
pub fn save_checkpoint(root: &Path, doc: &BoardDocument, manual: bool) -> Result<(), String> {
    validate(doc)?;
    let directory = version_directory(root, &doc.id)?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let name = format!(
        "{stamp}-{}.lightpen",
        if manual { "manual" } else { "auto" }
    );
    atomic_save(&directory.join(name), doc, None)?;
    let versions = list_versions(root, &doc.id)?;
    let mut total = 0u64;
    for (i, version) in versions.iter().enumerate() {
        total += version.bytes;
        if i > 0 && (i >= 20 || total > 100 * 1024 * 1024) {
            fs::remove_file(directory.join(&version.id)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn read_version(root: &Path, id: &str, version: &str) -> Result<BoardDocument, String> {
    if !version.ends_with(".lightpen")
        || version.len() > 100
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err("Неверный идентификатор версии.".into());
    }
    let directory = version_directory(root, id)?;
    let (doc, _) = read_document(&directory.join(version))?;
    if doc.id != id {
        return Err("Версия принадлежит другой доске.".into());
    }
    Ok(doc)
}

pub fn recent_documents(root: &Path) -> Result<Vec<RecentDocument>, String> {
    let directory = root.join("drafts");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<_> = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
            let p = e.path();
            p.extension().is_some_and(|s| s == "lightpen")
                && !p
                    .file_stem()
                    .is_some_and(|s| s.to_string_lossy().ends_with(".previous"))
        })
        .collect();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.metadata().and_then(|m| m.modified()).ok()));
    let mut documents = Vec::new();
    for entry in files.into_iter().take(20) {
        let Ok(connection) =
            Connection::open_with_flags(entry.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let value = |key: &str| -> Option<String> {
            connection
                .query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
                    r.get(0)
                })
                .ok()
        };
        if let (Some(id), Some(title), Some(updated_at)) =
            (value("documentId"), value("title"), value("updatedAt"))
        {
            documents.push(RecentDocument {
                id,
                title,
                path: value("sourcePath"),
                updated_at,
            });
        }
    }
    Ok(documents)
}

pub fn open_draft(root: &Path, id: &str) -> Result<Recovery, String> {
    let path = draft_path(root, id)?;
    let (document, source, mut warning) = match read_document(&path) {
        Ok((document, source)) => (document, source, None),
        Err(original) => {
            let (document, source) = read_document(&path.with_extension("previous.lightpen"))
                .map_err(|_| original.clone())?;
            (
                document,
                source,
                Some(format!(
                    "Восстановлена предыдущая копия черновика. {original}"
                )),
            )
        }
    };
    let needs_save = source
        .as_ref()
        .is_some_and(|p| match read_document(Path::new(p)) {
            Ok((saved, _)) => saved != document,
            Err(_) => true,
        });
    if needs_save && warning.is_none() {
        warning=Some("В черновике есть изменения, которые ещё не записаны в отдельный файл. Сохраните доску или выберите другую папку.".into());
    }
    Ok(Recovery {
        document: Some(document),
        path: source,
        warning,
        needs_save,
    })
}

pub fn restore_session(root: &Path) -> Result<Recovery, String> {
    let session = root.join("session.json");
    if !session.exists() {
        return Ok(Recovery {
            document: None,
            path: None,
            warning: None,
            needs_save: false,
        });
    }
    let id = fs::read(&session)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned));
    if let Some(id) = id {
        if let Ok(recovery) = open_draft(root, &id) {
            return Ok(recovery);
        }
    }
    if let Some(recent) = recent_documents(root)?.first() {
        let mut recovery = open_draft(root, &recent.id)?;
        recovery.warning = Some("Последний сеанс повреждён. Открыта недавняя доска.".into());
        return Ok(recovery);
    }
    Ok(Recovery {
        document: None,
        path: None,
        warning: Some("Не удалось восстановить сеанс. Откройте сохранённый файл.".into()),
        needs_save: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    fn element(id: usize, kind: &str) -> Value {
        let mut value = json!({"id":format!("object-{id}"),"kind":kind,"x":-25.5,"y":40.25,"width":220.0,"height":180.0,"color":"#0f6cbd","fill":"#fff1a8","strokeWidth":3.0,"opacity":1.0,"createdAt":1793624400000.0});
        match kind {
            "stroke" => value["points"] = json!([[0.0, 0.0, 0.1, 0.0], [20.0, -30.0, 0.95, 125.0]]),
            "text" | "sticky" => {
                value["text"] = json!("Привет, 日本語! ✨\nВторая строка");
                value["fontSize"] = json!(24.0);
            }
            "arrow" | "line" => {
                value["endX"] = json!(-120.0);
                value["endY"] = json!(-60.0);
            }
            "image" => value["dataUrl"] = json!("data:image/png;base64,iVBORw0KGgo="),
            _ => {}
        }
        value
    }
    fn document() -> BoardDocument {
        BoardDocument {
            schema_version: 1,
            id: "test-document".into(),
            title: "Доска 日本語 ✨".into(),
            revision: 42,
            created_at: "2026-11-02T10:00:00Z".into(),
            updated_at: "2026-11-02T10:30:00Z".into(),
            elements: [
                "stroke",
                "rectangle",
                "ellipse",
                "diamond",
                "arrow",
                "line",
                "text",
                "sticky",
                "image",
            ]
            .iter()
            .enumerate()
            .map(|(i, k)| element(i, k))
            .collect(),
        }
    }

    #[test]
    fn version_two_round_trips_formatting_frames_math_and_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = document();
        doc.schema_version = 2;
        doc.elements[6]["bold"] = json!(true);
        doc.elements[6]["italic"] = json!(true);
        doc.elements[6]["textAlign"] = json!("center");
        doc.elements[6]["fontSize"] = json!(47);
        doc.elements[1]["groupId"] = json!("group-123");
        doc.elements[1]["locked"] = json!(true);
        doc.elements[4]["startBinding"] = json!({"elementId":"object-1","side":"right"});
        doc.elements[0]["ink"] =
            json!({"smoothing":80,"stabilization":55,"minWidth":20,"pressure":125});
        let mut frame = element(20, "text");
        frame["kind"] = json!("frame");
        frame["text"] = json!("План");
        doc.elements.push(frame);
        let mut math = element(21, "text");
        math["kind"] = json!("math");
        math["text"] = json!("\\frac{a}{b}");
        doc.elements.push(math);
        let path = dir.path().join("Новая версия.lightpen");
        atomic_save(&path, &doc, None).unwrap();
        assert_eq!(read_document(&path).unwrap().0, doc);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn version_history_is_bounded_and_documents_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = document();
        for revision in 0..24 {
            doc.revision = revision;
            save_checkpoint(dir.path(), &doc, true).unwrap();
        }
        let list = list_versions(dir.path(), &doc.id).unwrap();
        assert_eq!(list.len(), 20);
        assert_eq!(list[0].revision, 23);
        assert_eq!(list[0].objects, doc.elements.len());
        assert_eq!(read_version(dir.path(), &doc.id, &list[0].id).unwrap(), doc);
        assert!(read_version(dir.path(), &doc.id, "../../session.json").is_err());
        assert!(list_versions(dir.path(), "../bad").is_err());
        assert!(read_version(dir.path(), "another-document", &list[0].id).is_err());
    }
    #[test]
    fn automatic_history_captures_previous_state_and_throttles_repeated_saves() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = document();
        persist_session(dir.path(), &doc, None).unwrap();
        assert!(list_versions(dir.path(), &doc.id).unwrap().is_empty());
        let old = doc.clone();
        doc.revision += 1;
        doc.elements[1]["x"] = json!(950);
        persist_session(dir.path(), &doc, None).unwrap();
        let versions = list_versions(dir.path(), &doc.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert!(!versions[0].manual);
        assert_eq!(
            read_version(dir.path(), &doc.id, &versions[0].id).unwrap(),
            old
        );
        doc.revision += 1;
        persist_session(dir.path(), &doc, None).unwrap();
        assert_eq!(list_versions(dir.path(), &doc.id).unwrap().len(), 1);
        assert_eq!(restore_session(dir.path()).unwrap().document.unwrap(), doc);
    }
    #[test]
    fn invalid_new_metadata_cannot_replace_a_saved_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("safe.lightpen");
        let doc = document();
        atomic_save(&path, &doc, None).unwrap();
        let before = fs::read(&path).unwrap();
        for (index, key, value) in [
            (1, "groupId", json!("../bad")),
            (1, "locked", json!("yes")),
            (6, "textAlign", json!("bad")),
            (
                4,
                "startBinding",
                json!({"elementId":"a","side":"diagonal"}),
            ),
            (
                0,
                "ink",
                json!({"smoothing":900,"stabilization":12,"minWidth":40,"pressure":100}),
            ),
        ] {
            let mut invalid = doc.clone();
            invalid.elements[index][key] = value;
            assert!(atomic_save(&path, &invalid, None).is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }
    #[test]
    fn history_failure_cannot_redirect_recovery_to_another_board() {
        let dir = tempfile::tempdir().unwrap();
        let a = document();
        let mut b = document();
        b.id = "another-board".into();
        persist_session(dir.path(), &a, None).unwrap();
        persist_session(dir.path(), &b, None).unwrap();
        persist_session(dir.path(), &a, None).unwrap();
        fs::write(dir.path().join("versions"), b"blocked history folder").unwrap();
        b.revision += 1;
        b.title = "Newest board despite history failure".into();
        assert!(persist_session(dir.path(), &b, None).is_err());
        assert_eq!(restore_session(dir.path()).unwrap().document.unwrap(), b);
    }

    #[test]
    fn round_trip_all_tools_and_unicode_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Моя доска 日本語.lightpen");
        let doc = document();
        atomic_save(&path, &doc, Some("C:\\Доски\\Идея.lightpen")).unwrap();
        let (loaded, source) = read_document(&path).unwrap();
        assert_eq!(loaded, doc);
        assert_eq!(source.as_deref(), Some("C:\\Доски\\Идея.lightpen"));
        assert!(fs::read(&path).unwrap().starts_with(b"SQLite format 3\0"));
    }
    #[test]
    fn atomic_replace_preserves_latest_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.lightpen");
        let mut doc = document();
        for revision in 0..30 {
            doc.revision = revision;
            atomic_save(&path, &doc, None).unwrap();
            assert_eq!(read_document(&path).unwrap().0.revision, revision);
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn failed_validation_keeps_existing_bytes_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.lightpen");
        let mut doc = document();
        atomic_save(&path, &doc, None).unwrap();
        let before = fs::read(&path).unwrap();
        doc.elements[0]["points"][0][2] = json!(2.0);
        assert!(atomic_save(&path, &doc, None).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    #[test]
    fn missing_parent_produces_an_error_without_partial_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("board.lightpen");
        assert!(atomic_save(&path, &document(), None).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn rejects_non_database_and_truncated_files_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.lightpen");
        for bytes in [
            b"not a board".to_vec(),
            b"SQLite format 3\0".to_vec(),
            vec![],
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(read_document(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    #[test]
    fn future_container_version_is_read_only_and_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.lightpen");
        atomic_save(&path, &document(), None).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        let before = fs::read(&path).unwrap();
        assert!(read_document(&path).unwrap_err().contains("версия"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    #[test]
    fn future_payload_version_is_rejected() {
        let mut doc = document();
        doc.schema_version = 99;
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn rejects_duplicate_ids_and_unknown_kinds() {
        let mut doc = document();
        doc.elements[1]["id"] = doc.elements[0]["id"].clone();
        assert!(validate(&doc).is_err());
        doc = document();
        doc.elements[0]["kind"] = json!("unknown");
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn rejects_negative_dimensions_and_missing_fields() {
        let mut doc = document();
        doc.elements[0]["width"] = json!(-1);
        assert!(validate(&doc).is_err());
        doc = document();
        doc.elements[0].as_object_mut().unwrap().remove("x");
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn rejects_invalid_pressure_and_timestamps() {
        for pressure in [-0.1, 1.1] {
            let mut doc = document();
            doc.elements[0]["points"][0][2] = json!(pressure);
            assert!(validate(&doc).is_err());
        }
        let mut doc = document();
        doc.elements[0]["points"][0][3] = json!(-1.0);
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn ignores_an_interrupted_sibling_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.lightpen");
        let doc = document();
        atomic_save(&path, &doc, None).unwrap();
        fs::write(dir.path().join(".interrupted-write.tmp"), b"incomplete").unwrap();
        assert_eq!(read_document(&path).unwrap().0, doc);
    }
    #[test]
    fn exported_bytes_replace_existing_file_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        atomic_bytes(&path, b"first").unwrap();
        atomic_bytes(&path, b"second complete image").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second complete image");
    }
    #[test]
    fn large_scene_and_long_pressure_stroke_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.lightpen");
        let mut doc = document();
        doc.elements = (0..10_000).map(|i| element(i, "rectangle")).collect();
        let mut stroke = element(10_000, "stroke");
        stroke["points"] = Value::Array(
            (0..10_000)
                .map(|i| {
                    json!([
                        i as f64 * 0.1,
                        (i as f64 * 0.03).sin() * 100.0,
                        i as f64 / 10_000.0,
                        i
                    ])
                })
                .collect(),
        );
        doc.elements.push(stroke);
        let start = Instant::now();
        atomic_save(&path, &doc, None).unwrap();
        let saved_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let loaded = read_document(&path).unwrap().0;
        let open_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(loaded == doc, "Large document changed after save/open");
        println!("PERF storage 10000 objects + 10000 points: save={saved_ms:.2}ms open={open_ms:.2}ms bytes={}",fs::metadata(path).unwrap().len());
    }
    #[test]
    fn new_boards_preserve_all_previous_unnamed_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let first = document();
        persist_session(dir.path(), &first, None).unwrap();
        let mut second = document();
        second.id = "another-document".into();
        second.title = "Вторая доска".into();
        persist_session(dir.path(), &second, None).unwrap();
        assert_eq!(
            restore_session(dir.path()).unwrap().document.unwrap(),
            second
        );
        assert_eq!(
            open_draft(dir.path(), &first.id).unwrap().document.unwrap(),
            first
        );
        assert_eq!(recent_documents(dir.path()).unwrap().len(), 2);
    }
    #[test]
    fn target_failure_still_recovers_the_latest_work() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("missing").join("board.lightpen");
        let doc = document();
        assert!(persist_session(dir.path(), &doc, target.to_str()).is_err());
        let recovered = restore_session(dir.path()).unwrap();
        assert_eq!(recovered.document.unwrap(), doc);
        assert!(recovered.needs_save);
    }
    #[test]
    fn corrupt_latest_draft_falls_back_to_previous_copy() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = document();
        persist_session(dir.path(), &doc, None).unwrap();
        let first = doc.clone();
        doc.revision += 1;
        persist_session(dir.path(), &doc, None).unwrap();
        fs::write(draft_path(dir.path(), &doc.id).unwrap(), b"incomplete").unwrap();
        let recovered = restore_session(dir.path()).unwrap();
        assert_eq!(recovered.document.unwrap(), first);
        assert!(recovered.warning.is_some());
    }
    #[test]
    fn invalid_session_pointer_falls_back_to_a_recent_board() {
        let dir = tempfile::tempdir().unwrap();
        let doc = document();
        persist_session(dir.path(), &doc, None).unwrap();
        fs::write(dir.path().join("session.json"), b"broken").unwrap();
        assert_eq!(restore_session(dir.path()).unwrap().document.unwrap(), doc);
    }
    #[test]
    fn draft_ids_cannot_escape_the_application_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_draft(dir.path(), "../../board").is_err());
        let mut doc = document();
        doc.id = "../escape".into();
        assert!(persist_session(dir.path(), &doc, None).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn read_only_destination_preserves_previous_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("readonly.lightpen");
        let mut doc = document();
        atomic_save(&path, &doc, None).unwrap();
        let before = fs::read(&path).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        doc.revision = 50;
        let result = atomic_save(&path, &doc, None);
        let after = fs::read(&path).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(before, after);
    }
}
