mod agent;
mod credentials;
mod local_links;
mod storage;

use base64::Engine;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use storage::BoardDocument;
use tauri::{Emitter, Manager, State};

// Tests use an isolated local profile while exercising the actual shipped binary.
// Normal launches retain the existing desktop profile and recovery behavior.
fn selected_profile(value: Option<std::ffi::OsString>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(
            "Профиль должен иметь полный локальный путь без переходов к родительским папкам."
                .into(),
        );
    }
    #[cfg(windows)]
    if !matches!(path.components().next(),Some(std::path::Component::Prefix(p)) if matches!(p.kind(),std::path::Prefix::Disk(_)|std::path::Prefix::VerbatimDisk(_)))
    {
        return Err("Профиль должен находиться на локальном диске.".into());
    }
    Ok(Some(path))
}
fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = selected_profile(std::env::var_os("LIGHT_PEN_PROFILE_DIR"))? {
        return Ok(path);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    #[test]
    fn profile_override_rejects_relative_or_parent_paths_and_defaults_without_touching_files() {
        assert!(selected_profile(None).unwrap().is_none());
        assert!(selected_profile(Some("relative".into())).is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(selected_profile(Some(root.path().as_os_str().to_owned()))
            .unwrap()
            .is_some());
        assert!(
            selected_profile(Some(root.path().join("..").join("other").into_os_string())).is_err()
        );
    }
}

#[derive(Default)]
struct StorageState {
    write_lock: Arc<Mutex<()>>,
}

fn document_argument(args: impl Iterator<Item = String>) -> Option<String> {
    args.filter(|s| s.to_lowercase().ends_with(".lightpen"))
        .find(|s| std::path::Path::new(s).is_file())
}

#[tauri::command]
fn startup_path() -> Option<String> {
    document_argument(std::env::args().skip(1))
}

#[tauri::command]
async fn load_credentials(app: tauri::AppHandle) -> Result<credentials::Credentials, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || credentials::load(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_credentials(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    credentials: credentials::Credentials,
) -> Result<(), String> {
    let root = data_root(&app)?;
    let lock = state.write_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Хранилище занято после ошибки.")?;
        credentials::save(&root, &credentials)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn persist_document(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    document: BoardDocument,
    path: Option<String>,
) -> Result<u64, String> {
    let root = data_root(&app)?;
    let lock = state.write_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Хранилище занято после ошибки.")?;
        storage::persist_session(&root, &document, path.as_deref())?;
        Ok(document.revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_document(path: String) -> Result<BoardDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::read_document(&PathBuf::from(path)).map(|(doc, _)| doc)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_session(app: tauri::AppHandle) -> Result<storage::Recovery, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::restore_session(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_recent_documents(
    app: tauri::AppHandle,
) -> Result<Vec<storage::RecentDocument>, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::recent_documents(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_recent_document(
    app: tauri::AppHandle,
    id: String,
) -> Result<storage::Recovery, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::open_draft(&root, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_png(path: String, data_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = data_url
            .strip_prefix("data:image/png;base64,")
            .ok_or("Неподдерживаемое изображение.")?;
        if data.len() > 90_000_000 {
            return Err("Экспортируемое изображение слишком большое.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "Повреждены данные PNG.")?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Повреждён заголовок PNG.".into());
        }
        storage::atomic_bytes(&PathBuf::from(path), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_versions(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<storage::DocumentVersion>, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::list_versions(&root, &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_checkpoint(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    document: BoardDocument,
) -> Result<(), String> {
    let root = data_root(&app)?;
    let lock = state.write_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        storage::save_checkpoint(&root, &document, true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_version(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<BoardDocument, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::read_version(&root, &id, &version))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_templates(app: tauri::AppHandle) -> Result<Vec<storage::TemplateSummary>, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::templates(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_template(app: tauri::AppHandle, id: String) -> Result<BoardDocument, String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::read_template(&root, &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_template(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    document: BoardDocument,
) -> Result<(), String> {
    let root = data_root(&app)?;
    let lock = state.write_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        storage::save_template(&root, &document)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn remove_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage::remove_template(&root, &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_template(path: String, document: BoardDocument) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::atomic_save(&PathBuf::from(path), &document, None)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_text(path: String, data: String, format: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !["csv", "tsv", "md", "json", "opml"].contains(&format.as_str())
            || PathBuf::from(&path).extension().and_then(|v| v.to_str()) != Some(format.as_str())
        {
            return Err("Неподдерживаемый формат текста.".into());
        }
        if data.len() > 8 * 1024 * 1024 {
            return Err("Текстовый экспорт превышает 8 МБ.".into());
        }
        storage::atomic_bytes(&PathBuf::from(path), data.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_vector(path: String, data: String, format: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > 100_000_000 {
            return Err("Экспорт превышает 100 МБ.".into());
        }
        let bytes = if format == "svg" {
            if !data.starts_with("<svg ") {
                return Err("Неверный заголовок SVG.".into());
            }
            data.into_bytes()
        } else if format == "pdf" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "Повреждён PDF.")?;
            if !bytes.starts_with(b"%PDF-") {
                return Err("Неверный заголовок PDF.".into());
            }
            bytes
        } else {
            return Err("Неподдерживаемый формат.".into());
        };
        storage::atomic_bytes(&PathBuf::from(path), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_local_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_links::validate_local_document(std::path::Path::new(&path))?;
        let target = std::fs::canonicalize(&path)
            .map_err(|_| "Файл по ссылке не найден. Возможно, он был перемещён.")?;
        if !target.is_file() {
            return Err("Выберите локальный файл.".into());
        }
        local_links::validate_local_document(&target)?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let canonical = target.to_string_lossy();
            let shell_path = if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                canonical
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&canonical)
                    .to_string()
            };
            std::process::Command::new("explorer.exe")
                .arg(shell_path)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = target;
            Err("Открытие внешних файлов доступно в Windows.".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows_core::Interface;
                    // Keep F5/Ctrl+R/Ctrl+F in the editor rather than browser navigation.
                    let result = (|| -> windows_core::Result<()> {
                        unsafe {
                            let settings = webview
                                .controller()
                                .CoreWebView2()?
                                .Settings()?
                                .cast::<ICoreWebView2Settings3>()?;
                            settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        eprintln!("Could not configure desktop shortcuts: {error}");
                    }
                })?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(path) = document_argument(args.into_iter().skip(1)) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(StorageState::default())
        .manage(agent::AgentState::default())
        .invoke_handler(tauri::generate_handler![
            persist_document,
            open_document,
            restore_session,
            export_png,
            startup_path,
            list_recent_documents,
            open_recent_document,
            list_versions,
            create_checkpoint,
            read_version,
            list_templates,
            read_template,
            save_template,
            remove_template,
            export_template,
            export_vector,
            export_text,
            open_local_file,
            load_credentials,
            save_credentials,
            agent::agent_start,
            agent::agent_attach,
            agent::agent_stop,
            agent::agent_status,
            agent::agent_reply,
            agent::agent_file,
            agent::agent_recent,
            agent::agent_open_link
        ])
        .run(tauri::generate_context!())
        .expect("Light Pen could not start");
}

pub fn run_mcp() {
    if let Err(error) = agent::mcp_main() {
        eprintln!("Light Pen MCP: {error}");
        std::process::exit(1);
    }
}
