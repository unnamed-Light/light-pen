//! Local extension registry and opt-in native helpers. JavaScript extensions never
//! receive an invoke handle. Native executables are a separately acknowledged,
//! broad-trust mode, not a filesystem/network security sandbox.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::State;

const MAX_REGISTRY: usize = 24 * 1024 * 1024;
const MAX_MESSAGE: usize = 1024 * 1024;
#[derive(Default)]
pub struct PluginsState {
    processes: Mutex<HashMap<String, Arc<LiveProcess>>>,
}
struct LiveProcess {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    output: Mutex<mpsc::Receiver<Value>>,
    #[cfg(windows)]
    _job: windows_job::Job,
}
impl Drop for LiveProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Extension management is available only in the main app".into());
    }
    Ok(())
}
fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(super::data_root(app)?.join("plugins").join("registry.json"))
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
fn validate_registry(value: &Value) -> Result<(), String> {
    let entries = value["entries"]
        .as_array()
        .ok_or("Invalid extension registry")?;
    if value["version"] != 1
        || entries.len() > 30
        || serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_REGISTRY
    {
        return Err("Extension registry exceeds limits".into());
    }
    let mut ids = std::collections::HashSet::new();
    for entry in entries {
        let manifest = &entry["package"]["manifest"];
        let id = manifest["id"].as_str().ok_or("Missing extension ID")?;
        if !valid_id(id)
            || !ids.insert(id)
            || manifest["apiVersion"] != 1
            || !entry["enabled"].is_boolean()
            || !entry["data"].is_object()
        {
            return Err("Invalid extension registry entry".into());
        }
        if !matches!(manifest["runtime"].as_str(), Some("worker" | "process")) {
            return Err("Unsupported extension runtime".into());
        }
        let requested = manifest["permissions"]
            .as_array()
            .ok_or("Missing extension permissions")?;
        let granted = entry["grants"]["permissions"]
            .as_array()
            .ok_or("Missing extension grants")?;
        if requested.iter().any(|p| {
            !matches!(
                p.as_str(),
                Some(
                    "board:read"
                        | "board:write"
                        | "storage"
                        | "network"
                        | "files:read"
                        | "files:write"
                        | "process"
                )
            )
        }) || granted.iter().any(|p| !requested.contains(p))
        {
            return Err("Invalid extension permissions".into());
        }
        if manifest["runtime"] == "worker"
            && (entry["package"]["code"]
                .as_str()
                .is_none_or(|s| s.len() > MAX_MESSAGE)
                || requested.iter().any(|p| p == "process"))
        {
            return Err("Invalid JavaScript extension".into());
        }
        if manifest["runtime"] == "process"
            && (!requested.iter().any(|p| p == "process")
                || manifest["process"]["executable"].as_str().is_none())
        {
            return Err("Native extension requires process permission".into());
        }
    }
    Ok(())
}
fn load_registry(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({"version":1,"entries":[]}));
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_REGISTRY as u64 {
        return Err("Extension registry exceeds 24 MB".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Extension registry is damaged")?;
    validate_registry(&value)?;
    Ok(value)
}
#[tauri::command]
pub async fn plugin_registry_load(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    main_window(&window)?;
    let path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_registry(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_registry_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    value: Value,
) -> Result<(), String> {
    main_window(&window)?;
    validate_registry(&value)?;
    let path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(path.parent().ok_or("Missing plugin directory")?)
            .map_err(|e| e.to_string())?;
        super::storage::atomic_bytes(
            &path,
            &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
fn installed(registry: &Value, id: &str) -> Result<Value, String> {
    registry["entries"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|e| e["package"]["manifest"]["id"] == id && e["enabled"] == true)
        })
        .cloned()
        .ok_or_else(|| "PLUGIN_DISABLED".into())
}
fn has_permission(entry: &Value, permission: &str) -> bool {
    entry["grants"]["permissions"]
        .as_array()
        .is_some_and(|p| p.iter().any(|p| p == permission))
}
fn checked_folder(text: &str) -> Result<PathBuf, String> {
    let path = super::selected_profile(Some(text.into()))?.ok_or("Missing folder")?;
    let folder = fs::canonicalize(path).map_err(|_| "Extension folder not found")?;
    if !folder.is_dir() {
        return Err("Choose a folder".into());
    }
    Ok(folder)
}
fn file_path(
    profile: &Path,
    folder: &Path,
    text: &str,
    write: bool,
    overwrite: bool,
    agent_folder: Option<&Path>,
) -> Result<PathBuf, String> {
    let raw = super::selected_profile(Some(text.into()))?.ok_or("Missing path")?;
    #[cfg(windows)]
    if raw
        .components()
        .skip(1)
        .any(|c| c.as_os_str().to_string_lossy().contains(':'))
    {
        return Err("Alternate streams are not allowed".into());
    }
    let path = if raw.exists() {
        if write && !overwrite {
            return Err("FILE_EXISTS: explicit overwrite required".into());
        }
        fs::canonicalize(&raw).map_err(|e| e.to_string())?
    } else {
        if !write {
            return Err("File not found".into());
        }
        fs::canonicalize(raw.parent().ok_or("Missing parent")?)
            .map_err(|_| "Output folder not found")?
            .join(raw.file_name().ok_or("Missing filename")?)
    };
    let private = fs::canonicalize(profile).map_err(|e| e.to_string())?;
    if path == folder
        || !path.starts_with(folder)
        || path.starts_with(private)
        || agent_folder.is_some_and(|root| !path.starts_with(root) || path == root)
    {
        return Err(
            "FILE_PERMISSION_REQUIRED: file outside granted folder or inside private app data"
                .into(),
        );
    }
    if path.is_dir() {
        return Err("Choose a file".into());
    }
    Ok(path)
}
fn write_file(path: &Path, data: &[u8], overwrite: bool) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing parent")?)
        .map_err(|e| e.to_string())?;
    temp.write_all(data)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    if overwrite {
        temp.persist(path).map_err(|e| e.to_string())?;
    } else {
        temp.persist_noclobber(path)
            .map_err(|_| "FILE_EXISTS: destination appeared; no file was replaced")?;
    }
    Ok(())
}
#[tauri::command]
pub async fn plugin_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    plugin_id: String,
    action: String,
    path: String,
    data: Option<String>,
    overwrite: bool,
    agent_folder: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    let root = super::data_root(&app)?;
    let registry = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = installed(&load_registry(&registry)?, &plugin_id)?;
        let permission = match action.as_str() {
            "read" => "files:read",
            "write" => "files:write",
            _ => return Err("Unsupported plugin file action".into()),
        };
        if !has_permission(&entry, permission) {
            return Err("FILE_PERMISSION_REQUIRED".into());
        }
        let folder = checked_folder(
            entry["grants"]["folder"]
                .as_str()
                .ok_or("FILE_PERMISSION_REQUIRED")?,
        )?;
        let agent_folder = agent_folder.as_deref().map(checked_folder).transpose()?;
        let target = file_path(
            &root,
            &folder,
            &path,
            action == "write",
            overwrite,
            agent_folder.as_deref(),
        )?;
        if action == "read" {
            if fs::metadata(&target).map_err(|e| e.to_string())?.len() > MAX_MESSAGE as u64 {
                return Err("Plugin file exceeds 1 MB".into());
            }
            let text = fs::read_to_string(&target).map_err(|_| "Plugin file is not UTF-8 text")?;
            Ok(json!({"path":target,"text":text}))
        } else {
            let data = data.ok_or("Missing file text")?;
            if data.len() > MAX_MESSAGE {
                return Err("Plugin file exceeds 1 MB".into());
            }
            write_file(&target, data.as_bytes(), overwrite)?;
            Ok(json!({"path":target,"bytes":data.len()}))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut out = Vec::new();
    loop {
        let chunk = reader.fill_buf().map_err(|e| e.to_string())?;
        if chunk.is_empty() {
            return if out.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete native plugin line".into())
            };
        }
        let count = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(chunk.len());
        if out.len() + count > MAX_MESSAGE {
            return Err("Native plugin message exceeds 1 MB".into());
        }
        out.extend_from_slice(&chunk[..count]);
        let complete = out.last() == Some(&b'\n');
        reader.consume(count);
        if complete {
            return serde_json::from_slice(&out)
                .map(Some)
                .map_err(|_| "Invalid native plugin JSON".into());
        }
    }
}
#[tauri::command]
pub async fn plugin_process_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, PluginsState>,
    plugin_id: String,
    acknowledge_risk: bool,
) -> Result<String, String> {
    main_window(&window)?;
    if !acknowledge_risk {
        return Err("PROCESS_CONFIRMATION_REQUIRED".into());
    }
    let root = super::data_root(&app)?;
    let entry = installed(&load_registry(&registry_path(&app)?)?, &plugin_id)?;
    if !has_permission(&entry, "process") || entry["package"]["manifest"]["runtime"] != "process" {
        return Err("PROCESS_PERMISSION_REQUIRED".into());
    }
    let process = &entry["package"]["manifest"]["process"];
    let executable = super::selected_profile(Some(
        process["executable"]
            .as_str()
            .ok_or("Missing executable")?
            .into(),
    ))?
    .ok_or("Missing executable")?;
    let executable =
        fs::canonicalize(executable).map_err(|_| "Native extension executable not found")?;
    if !executable.is_file() {
        return Err("Choose an executable file".into());
    }
    #[cfg(windows)]
    if executable
        .extension()
        .and_then(|e| e.to_str())
        .is_none_or(|e| !e.eq_ignore_ascii_case("exe"))
    {
        return Err("Native extensions must use an explicit .exe, without a shell".into());
    }
    let args = process["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|a| {
                    a.as_str()
                        .map(String::from)
                        .ok_or("Invalid process argument")
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if args.len() > 32 || args.iter().any(|a| a.len() > 32768) {
        return Err("Process arguments exceed limits".into());
    }
    let directory = root.join("plugin-processes").join(&plugin_id);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    if processes.len() >= 2 {
        return Err("At most two native extensions may be started".into());
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .env("TEMP", &directory)
        .env("TMP", &directory)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(system) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system);
        }
        command.creation_flags(0x0800_0000 | 0x0000_0004); // Hidden and suspended until resource limits are attached.
    }
    #[cfg(not(windows))]
    {
        return Err("Native extensions currently require Windows job limits".into());
    }
    #[cfg(windows)]
    {
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let job = match windows_job::Job::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let input = child.stdin.take().ok_or("Missing native plugin input")?;
        let output = child.stdout.take().ok_or("Missing native plugin output")?;
        let (tx, rx) = mpsc::sync_channel(16);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(message)) => {
                        if tx.send(message).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = tx.send(json!({"kind":"error","error":"Native extension exited"}));
                        break;
                    }
                    Err(error) => {
                        let _ = tx.send(json!({"kind":"error","error":error}));
                        break;
                    }
                }
            }
        });
        let id = random_id()?;
        processes.insert(
            id.clone(),
            Arc::new(LiveProcess {
                child: Mutex::new(child),
                input: Mutex::new(input),
                output: Mutex::new(rx),
                _job: job,
            }),
        );
        Ok(id)
    }
}
#[tauri::command]
pub async fn plugin_process_send(
    window: tauri::WebviewWindow,
    state: State<'_, PluginsState>,
    process_id: String,
    message: Value,
) -> Result<(), String> {
    main_window(&window)?;
    let process = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get(&process_id)
        .cloned()
        .ok_or("Native extension is not running")?;
    let bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("Native plugin message exceeds 1 MB".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut input = process.input.lock().map_err(|e| e.to_string())?;
        input
            .write_all(&bytes)
            .and_then(|()| input.write_all(b"\n"))
            .and_then(|()| input.flush())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_process_read(
    window: tauri::WebviewWindow,
    state: State<'_, PluginsState>,
    process_id: String,
) -> Result<Vec<Value>, String> {
    main_window(&window)?;
    let process = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get(&process_id)
        .cloned()
        .ok_or("Native extension is not running")?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = process.output.lock().map_err(|e| e.to_string())?;
        match output.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => Ok(vec![value]),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(vec![]),
            Err(_) => Err("Native extension exited".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn plugin_process_stop(
    window: tauri::WebviewWindow,
    state: State<'_, PluginsState>,
    process_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    if let Some(process) = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&process_id)
    {
        let mut child = process.child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[cfg(windows)]
mod windows_job {
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, process::Child};
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Limits {
        basic: Basic,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            data: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }
    pub struct Job(Handle);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Job {
        pub fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err("Cannot create native extension resource limits".into());
                }
                let job = Self(handle);
                let mut limits = Limits::default();
                limits.basic.flags = 0x2000 | 0x8 | 0x100 | 0x2; // Kill on close, one process, memory and CPU time.
                limits.basic.active = 1;
                limits.basic.process_time = 100_000_000; // Ten seconds of CPU for this one-shot process.
                limits.process_memory = 256 * 1024 * 1024;
                if SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    size_of::<Limits>() as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
                    || NtResumeProcess(child.as_raw_handle()) < 0
                {
                    return Err("Cannot apply native extension resource limits; process was not allowed to run".into());
                }
                Ok(job)
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_files_reject_escape_private_data_and_no_clobber() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let folder = temp.path().join("files");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&folder).unwrap();
        let folder = fs::canonicalize(folder).unwrap();
        let target = folder.join("тест.json");
        let checked = file_path(
            &profile,
            &folder,
            target.to_str().unwrap(),
            true,
            false,
            None,
        )
        .unwrap();
        write_file(&checked, b"original", false).unwrap();
        assert!(write_file(&checked, b"replacement", false).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(file_path(
            &profile,
            &folder,
            profile.join("vault.json").to_str().unwrap(),
            true,
            true,
            None
        )
        .is_err());
        let broad = fs::canonicalize(temp.path()).unwrap();
        assert!(file_path(
            &profile,
            &broad,
            profile.join("vault.json").to_str().unwrap(),
            true,
            true,
            None
        )
        .is_err());
        let other = tempfile::tempdir().unwrap();
        let other = fs::canonicalize(other.path()).unwrap();
        assert!(file_path(
            &profile,
            &folder,
            target.to_str().unwrap(),
            false,
            false,
            Some(&other)
        )
        .is_err());
    }
    #[test]
    fn native_protocol_bounds_and_incomplete_messages() {
        assert_eq!(
            read_message(&mut &b"{\"kind\":\"result\",\"result\":42}\n"[..])
                .unwrap()
                .unwrap()["result"],
            42
        );
        assert!(read_message(&mut &b"{}"[..]).is_err());
        assert!(read_message(&mut &vec![b'a'; MAX_MESSAGE + 1][..]).is_err());
    }
    #[test]
    fn registry_rejects_undeclared_process_authority() {
        let registry = json!({"version":1,"entries":[{"package":{"manifest":{"id":"demo","apiVersion":1,"runtime":"worker","permissions":["board:read"]},"code":"LightPen.register({});"},"enabled":true,"grants":{"permissions":["process"]},"data":{}}]});
        assert!(validate_registry(&registry).is_err());
        assert!(valid_id("lightpen.example"));
        assert!(!valid_id("../escape"));
    }
}
