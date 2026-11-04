use super::*;

pub fn validate_extra(el: &Value, kind: &str) -> Result<(), String> {
    if let Some(path) = el.get("groupPath") {
        let path = path
            .as_array()
            .filter(|p| !p.is_empty() && p.len() <= 32)
            .ok_or("Повреждена вложенная группа.")?;
        let mut seen = HashSet::new();
        for id in path {
            let id = id
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                .ok_or("Повреждена группа.")?;
            if !seen.insert(id) {
                return Err("Цикл в группе.".into());
            }
        }
        if el.get("groupId") != path.first() {
            return Err("Повреждён корень группы.".into());
        }
    }
    if el.get("fontSize").is_some() && !(8.0..=256.0).contains(&numeric(el, "fontSize")?) {
        return Err("Повреждён размер текста.".into());
    }
    for (key, max) in [("name", 250), ("label", 2000)] {
        if el
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| s.chars().count() > max))
        {
            return Err("Повреждено имя или подпись объекта.".into());
        }
    }
    if el.get("hidden").is_some_and(|v| !v.is_boolean()) {
        return Err("Повреждена видимость объекта.".into());
    }
    if el.get("rotation").is_some() && numeric(el, "rotation")?.abs() > 360.0 {
        return Err("Повреждён угол поворота.".into());
    }
    if el
        .get("slideOrder")
        .is_some_and(|v| v.as_u64().is_none_or(|n| n > 1_000_000))
    {
        return Err("Повреждён порядок слайдов.".into());
    }
    if el.get("connectorStyle").is_some_and(|v| {
        v.as_str()
            .is_none_or(|s| !["straight", "curve", "orthogonal"].contains(&s))
    }) {
        return Err("Повреждён соединитель.".into());
    }
    if let Some(route) = el.get("route") {
        let points = route
            .as_array()
            .filter(|a| a.len() <= 200)
            .ok_or("Повреждён маршрут.")?;
        for p in points {
            numeric(p, "x")?;
            numeric(p, "y")?;
        }
    }
    if let Some(link) = el.get("link") {
        if link
            .get("path")
            .and_then(Value::as_str)
            .is_none_or(|s| s.len() > 16384 || s.chars().any(char::is_control))
            || link.get("pageId").is_some_and(|v| {
                v.as_str().is_none_or(|s| {
                    s.is_empty()
                        || s.len() > 128
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
            })
            || link
                .get("elementId")
                .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 128))
            || link
                .get("label")
                .is_some_and(|v| v.as_str().is_none_or(|s| s.chars().count() > 250))
        {
            return Err("Повреждена локальная ссылка.".into());
        }
    } else if kind == "link" {
        return Err("У ссылки нет назначения.".into());
    }
    if let Some(widget) = el.get("widget") {
        if kind != "rectangle"
            || widget
                .get("pluginId")
                .and_then(Value::as_str)
                .is_none_or(|s| {
                    s.is_empty()
                        || s.len() > 128
                        || !s.as_bytes()[0].is_ascii_alphanumeric()
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                })
            || widget
                .get("type")
                .and_then(Value::as_str)
                .is_none_or(|s| s.is_empty() || s.len() > 128)
            || widget
                .get("version")
                .and_then(Value::as_u64)
                .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
            || widget
                .get("fallback")
                .and_then(Value::as_str)
                .is_none_or(|s| s.chars().count() > 100_000)
            || serde_json::to_vec(widget.get("data").unwrap_or(&Value::Null))
                .map_err(|e| e.to_string())?
                .len()
                > 1_000_000
        {
            return Err("Повреждены данные виджета.".into());
        }
    }
    if kind == "table" {
        let rows = el
            .get("cells")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty() && a.len() <= 1000)
            .ok_or("Повреждена таблица.")?;
        let columns = rows[0].as_array().map_or(0, Vec::len);
        if columns == 0 || columns > 200 || rows.len() * columns > 50_000 {
            return Err("В таблице должно быть 1–200 столбцов и до 50 000 ячеек.".into());
        }
        for row in rows {
            let cells = row
                .as_array()
                .filter(|a| a.len() == columns)
                .ok_or("Строки таблицы имеют разную длину.")?;
            if cells
                .iter()
                .any(|v| v.as_str().is_none_or(|s| s.chars().count() > 10000))
            {
                return Err("Повреждена ячейка таблицы.".into());
            }
        }
    }
    if kind == "task" {
        let task = el.get("task").ok_or("Нет данных задачи.")?;
        if task
            .get("status")
            .and_then(Value::as_str)
            .is_none_or(|s| !["todo", "doing", "done"].contains(&s))
        {
            return Err("Повреждён статус задачи.".into());
        }
        if task.get("due").is_some_and(|v| {
            v.as_str().is_none_or(|s| {
                s.len() != 10
                    || !s.bytes().enumerate().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            c == b'-'
                        } else {
                            c.is_ascii_digit()
                        }
                    })
            })
        }) {
            return Err("Повреждён срок задачи.".into());
        }
        let items = task
            .get("items")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 1000)
            .ok_or("Повреждён список задачи.")?;
        let mut ids = HashSet::new();
        for item in items {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Повреждён пункт задачи.")?;
            if !ids.insert(id)
                || item.get("done").is_none_or(|v| !v.is_boolean())
                || item
                    .get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.chars().count() > 10000)
            {
                return Err("Повреждён пункт задачи.".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSummary {
    pub id: String,
    pub title: String,
    pub objects: usize,
    pub elements: Vec<Value>,
}
pub fn templates(root: &Path) -> Result<Vec<TemplateSummary>, String> {
    let dir = root.join("templates");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut paths = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s == "lightpen"))
        .collect::<Vec<_>>();
    paths.sort();
    let mut result = Vec::new();
    for path in paths.into_iter().take(128) {
        let doc = read_document(&path)?.0;
        let elements = doc
            .elements
            .iter()
            .take(120)
            .map(|el| {
                Value::Object(
                    el.as_object()
                        .unwrap()
                        .iter()
                        .filter(|(k, _)| {
                            [
                                "id",
                                "kind",
                                "x",
                                "y",
                                "width",
                                "height",
                                "color",
                                "fill",
                                "strokeWidth",
                                "opacity",
                                "rotation",
                                "createdAt",
                                "endX",
                                "endY",
                            ]
                            .contains(&k.as_str())
                        })
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                )
            })
            .collect();
        result.push(TemplateSummary {
            id: doc.id,
            title: doc.title,
            objects: doc.elements.len(),
            elements,
        });
    }
    Ok(result)
}
pub fn read_template(root: &Path, id: &str) -> Result<BoardDocument, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Неверный идентификатор шаблона.".into());
    }
    read_document(&root.join("templates").join(format!("{id}.lightpen"))).map(|r| r.0)
}
pub fn save_template(root: &Path, doc: &BoardDocument) -> Result<(), String> {
    validate(doc)?;
    if doc.elements.is_empty() {
        return Err("В шаблоне нет объектов.".into());
    }
    let dir = root.join("templates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.lightpen", doc.id));
    if !path.exists() && fs::read_dir(&dir).map_err(|e| e.to_string())?.count() >= 128 {
        return Err("В библиотеке уже 128 шаблонов. Удалите ненужные.".into());
    }
    atomic_save(&path, doc, None)
}
pub fn remove_template(root: &Path, id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Неверный идентификатор шаблона.".into());
    }
    fs::remove_file(root.join("templates").join(format!("{id}.lightpen")))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document() -> BoardDocument {
        let now = "2026-11-03T00:00:00Z";
        let base = json!({"id":"table","kind":"table","x":100,"y":200,"width":400,"height":160,"color":"#0f6cbd","fill":"#ffffff","strokeWidth":2,"opacity":0.8,"createdAt":1793664000000u64,"text":"Смета 日本語","fontSize":18,"rotation":35,"hidden":false,"name":"Расчёт","cells":[["Название","Цена"],["Пример","123"]]});
        let mut task = base.clone();
        task["id"] = json!("task");
        task["kind"] = json!("task");
        task["task"] = json!({"status":"doing","due":"2026-11-09","items":[{"id":"one","text":"Проверить ✓","done":true}]});
        let mut link = base.clone();
        link["id"] = json!("link");
        link["kind"] = json!("link");
        link["link"] = json!({"path":"C:\\Доски\\Проект.lightpen","elementId":"target","label":"Открыть проект"});
        let mut arrow = base.clone();
        arrow["id"] = json!("arrow");
        arrow["kind"] = json!("arrow");
        arrow["endX"] = json!(200);
        arrow["endY"] = json!(100);
        arrow["connectorStyle"] = json!("orthogonal");
        arrow["label"] = json!("переход");
        arrow["route"] = json!([{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":200,"y":100}]);
        BoardDocument {
            schema_version: 3,
            pages: None,
            id: "studio-qa".into(),
            title: "Новый формат".into(),
            revision: 7,
            created_at: now.into(),
            updated_at: now.into(),
            elements: vec![base, task, link, arrow],
        }
    }
    #[test]
    fn format_three_round_trip_preserves_all_structured_fields_and_container_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Кириллица.lightpen");
        let doc = document();
        atomic_save(&path, &doc, None).unwrap();
        assert_eq!(read_document(&path).unwrap().0, doc);
        let conn = Connection::open(path).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn invalid_structured_data_never_replaces_valid_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.lightpen");
        let doc = document();
        atomic_save(&path, &doc, None).unwrap();
        let bytes = fs::read(&path).unwrap();
        for (i, key, value) in [
            (0, "cells", json!([["one"], ["two", "three"]])),
            (0, "rotation", json!(361)),
            (0, "hidden", json!("yes")),
            (1, "task", json!({"status":"other","items":[]})),
            (
                1,
                "task",
                json!({"status":"todo","items":[{"id":"x","text":"a","done":true},{"id":"x","text":"b","done":false}]}),
            ),
            (2, "link", json!({"path":"bad\u{0}file"})),
            (3, "route", json!([{"x":"bad","y":0}])),
        ] {
            let mut invalid = doc.clone();
            invalid.elements[i][key] = value;
            assert!(atomic_save(&path, &invalid, None).is_err(), "{key}");
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    #[test]
    fn local_library_is_independent_of_recovery_and_portable_file() {
        let dir = tempfile::tempdir().unwrap();
        let doc = document();
        persist_session(dir.path(), &doc, None).unwrap();
        let mut template = doc.clone();
        template.id = "template-one".into();
        template.title = "Свой шаблон".into();
        save_template(dir.path(), &template).unwrap();
        let list = templates(dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, template.id);
        assert_eq!(list[0].objects, 4);
        assert_eq!(read_template(dir.path(), &template.id).unwrap(), template);
        assert_eq!(
            restore_session(dir.path()).unwrap().document.unwrap().id,
            doc.id
        );
        let path = dir.path().join("portable.lightpen-template");
        atomic_save(&path, &template, None).unwrap();
        assert_eq!(read_document(&path).unwrap().0, template);
        remove_template(dir.path(), &template.id).unwrap();
        assert!(templates(dir.path()).unwrap().is_empty());
        assert!(path.exists());
    }
    #[test]
    fn template_identifiers_cannot_escape_the_library() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["../outside", "..\\outside", "C:\\outside", "", "a/b"] {
            assert!(remove_template(dir.path(), id).is_err());
        }
        let mut doc = document();
        doc.id = "..\\outside".into();
        assert!(save_template(dir.path(), &doc).is_err());
    }
    #[test]
    fn nested_groups_require_version_four_and_round_trip_without_flattening() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = document();
        doc.elements[0]["groupId"] = json!("outer");
        doc.elements[0]["groupPath"] = json!(["outer", "inner"]);
        assert!(validate(&doc).is_err());
        doc.schema_version = 4;
        validate(&doc).unwrap();
        let path = dir.path().join("nested.lightpen");
        atomic_save(&path, &doc, None).unwrap();
        assert_eq!(read_document(&path).unwrap().0, doc);
        let before = fs::read(&path).unwrap();
        doc.elements[0]["groupPath"] = json!(["outer", "outer"]);
        assert!(atomic_save(&path, &doc, None).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    #[test]
    fn typed_rows_and_task_planning_round_trip_and_invalid_edits_preserve_saved_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.lightpen");
        let mut doc = document();
        doc.schema_version = 4;
        doc.elements[0]["grid"] = json!({"rows":["header","record"],"columns":[{"id":"name","type":"text"},{"id":"price","type":"number"}]});
        doc.elements[1]["task"] = json!({"status":"doing","start":"2024-02-29","due":"2026-11-10","description":"Описание с 日本語 и ✓","priority":"high","estimate":2.5,"tags":["План","Работа"],"dependencies":["another"],"archived":false,"items":[{"id":"one","text":"Проверить","done":true}]});
        atomic_save(&path, &doc, None).unwrap();
        assert_eq!(read_document(&path).unwrap().0, doc);
        let bytes = fs::read(&path).unwrap();
        for (index, key, value) in [
            (
                0,
                "grid",
                json!({"rows":["same","same"],"columns":[{"id":"name","type":"text"},{"id":"price","type":"number"}]}),
            ),
            (
                0,
                "grid",
                json!({"rows":["header","row"],"columns":[{"id":"name","type":"script"},{"id":"price","type":"number"}]}),
            ),
        ] {
            let mut invalid = doc.clone();
            invalid.elements[index][key] = value;
            assert!(atomic_save(&path, &invalid, None).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        for (key, value) in [
            ("due", json!("2026-02-29")),
            ("start", json!("2026-04-31")),
            ("estimate", json!(-1)),
            ("priority", json!("other")),
            ("tags", json!(["same", "same"])),
            ("dependencies", json!(["task"])),
        ] {
            let mut invalid = doc.clone();
            invalid.elements[1]["task"][key] = value;
            assert!(atomic_save(&path, &invalid, None).is_err(), "{key}");
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        doc.schema_version = 3;
        assert!(atomic_save(&path, &doc, None).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}
