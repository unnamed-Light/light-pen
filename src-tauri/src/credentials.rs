//! Private capabilities never enter a board, export, template or diagnostics.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};

const MAGIC: &[u8; 8] = b"LPKEY1\0\0";
const MAX_PLAIN: usize = 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedAccount {
    pub server: String,
    pub token: String,
    pub login: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedRoom {
    pub server: String,
    pub room: String,
    pub token: String,
    pub title: String,
    pub role: String,
    pub accessed_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub version: u32,
    pub accounts: Vec<SavedAccount>,
    pub rooms: Vec<SavedRoom>,
}
impl Default for Credentials {
    fn default() -> Self {
        Self {
            version: 1,
            accounts: vec![],
            rooms: vec![],
        }
    }
}
fn valid_server(text: &str) -> bool {
    let Ok(url) = url::Url::parse(text) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/"
        && (url.scheme() == "https"
            || url.scheme() == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(&host))
        && url.origin().ascii_serialization() == text
}
fn valid_token(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn validate(value: &Credentials) -> Result<(), String> {
    if value.version != 1 || value.accounts.len() > 32 || value.rooms.len() > 400 {
        return Err("Неподдерживаемое хранилище доступа.".into());
    }
    let mut accounts = HashSet::new();
    let mut rooms = HashSet::new();
    for a in &value.accounts {
        if !valid_server(&a.server)
            || !valid_token(&a.token)
            || a.login.is_empty()
            || a.login.len() > 128
            || a.name.encode_utf16().count() > 80
            || !accounts.insert(&a.server)
        {
            return Err("Повреждён сохранённый аккаунт.".into());
        }
    }
    for r in &value.rooms {
        let id = r.room.as_bytes();
        let valid_id = id.len() == 36
            && id.iter().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    *c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            });
        if !valid_server(&r.server)
            || !valid_token(&r.token)
            || !valid_id
            || r.title.encode_utf16().count() > 250
            || !["owner", "editor", "viewer"].contains(&r.role.as_str())
            || r.accessed_at > 9_007_199_254_740_991
            || !rooms.insert((&r.server, &r.room))
        {
            return Err("Повреждён сохранённый доступ к доске.".into());
        }
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    checksum: String,
    body: String,
}
fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn clear(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe {
            std::ptr::write_volatile(byte, 0);
        }
    }
}
pub fn save(root: &Path, value: &Credentials) -> Result<(), String> {
    validate(value)?;
    let body = serde_json::to_string(value).map_err(|_| "Не удалось подготовить доступ.")?;
    if body.len() > MAX_PLAIN {
        return Err("Слишком много сохранённых данных доступа.".into());
    }
    let envelope = Envelope {
        format: "Light Pen access 1".into(),
        checksum: checksum(body.as_bytes()),
        body,
    };
    let mut plain = serde_json::to_vec(&envelope).map_err(|_| "Не удалось подготовить доступ.")?;
    let encrypted = protect(&plain);
    clear(&mut plain);
    let encrypted = encrypted?;
    let mut bytes = MAGIC.to_vec();
    bytes.extend_from_slice(&encrypted);
    fs::create_dir_all(root).map_err(|_| "Не удалось открыть хранилище доступа.")?;
    super::storage::atomic_bytes(&root.join("credentials.dpapi"), &bytes)
}
pub fn load(root: &Path) -> Result<Credentials, String> {
    let path = root.join("credentials.dpapi");
    if !path.exists() {
        return Ok(Credentials::default());
    }
    let size = fs::metadata(&path)
        .map_err(|_| "Не удалось прочитать хранилище доступа.")?
        .len();
    if size > 2 * MAX_PLAIN as u64 {
        return Err("Повреждён размер хранилища доступа.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Не удалось прочитать хранилище доступа.")?;
    if !bytes.starts_with(MAGIC) {
        return Err("Неизвестный формат хранилища доступа.".into());
    }
    let mut plain = unprotect(&bytes[MAGIC.len()..])?;
    let parsed = serde_json::from_slice::<Envelope>(&plain);
    clear(&mut plain);
    let envelope = parsed.map_err(|_| "Повреждено хранилище доступа.")?;
    if envelope.format != "Light Pen access 1"
        || envelope.body.len() > MAX_PLAIN
        || checksum(envelope.body.as_bytes()) != envelope.checksum
    {
        return Err("Нарушена целостность хранилища доступа.".into());
    }
    let result: Credentials =
        serde_json::from_str(&envelope.body).map_err(|_| "Повреждено хранилище доступа.")?;
    validate(&result)?;
    Ok(result)
}
#[cfg(windows)]
#[repr(C)]
struct Blob {
    len: u32,
    data: *mut u8,
}
#[cfg(windows)]
#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}
#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > 2 * MAX_PLAIN {
        return Err("Недопустимый размер данных доступа.".into());
    }
    let input = Blob {
        len: bytes.len() as u32,
        data: bytes.as_ptr() as *mut u8,
    };
    let entropy_bytes = b"Light Pen access v1";
    let entropy = Blob {
        len: entropy_bytes.len() as u32,
        data: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // Per-user protection, no machine-wide flag and no authentication/UI prompts.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows не смог открыть защищённый доступ. Используйте исходный профиль Windows или войдите заново.".into());
    }
    if output.data.is_null() {
        return Err("Windows вернул пустое хранилище доступа.".into());
    }
    let data = if output.len as usize <= 2 * MAX_PLAIN {
        unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() }
    } else {
        unsafe {
            LocalFree(output.data.cast());
        }
        return Err("Недопустимый размер защищённого доступа.".into());
    };
    if !encrypt {
        unsafe {
            for i in 0..output.len as usize {
                std::ptr::write_volatile(output.data.add(i), 0);
            }
        }
    }
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(data)
}
#[cfg(windows)]
pub(crate) fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, true)
}
#[cfg(windows)]
pub(crate) fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, false)
}
#[cfg(not(windows))]
pub(crate) fn protect(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("Защищённое хранение доступа доступно в Windows.".into())
}
#[cfg(not(windows))]
pub(crate) fn unprotect(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("Защищённое хранение доступа доступно в Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Credentials {
        Credentials {
            version: 1,
            accounts: vec![SavedAccount {
                server: "https://boards.example.org".into(),
                token: "A".repeat(43),
                login: "test".into(),
                name: "Проверка".into(),
            }],
            rooms: vec![SavedRoom {
                server: "http://127.0.0.1:8787".into(),
                room: "12345678-1234-1234-1234-123456789abc".into(),
                token: "B".repeat(43),
                title: "Доска 日本語".into(),
                role: "owner".into(),
                accessed_at: 100,
            }],
        }
    }
    #[test]
    fn rejects_invalid_capabilities_endpoints_and_duplicates() {
        let mut v = fixture();
        validate(&v).unwrap();
        v.accounts[0].server = "http://example.org".into();
        assert!(validate(&v).is_err());
        v = fixture();
        v.rooms[0].token = "short".into();
        assert!(validate(&v).is_err());
        v = fixture();
        v.rooms.push(v.rooms[0].clone());
        assert!(validate(&v).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_protection_round_trips_without_plaintext_and_tampering_does_not_replace_valid_state()
    {
        let root = tempfile::tempdir().unwrap();
        let value = fixture();
        save(root.path(), &value).unwrap();
        let path = root.path().join("credentials.dpapi");
        let bytes = fs::read(&path).unwrap();
        assert!(!bytes
            .windows(43)
            .any(|w| w == b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(load(root.path()).unwrap().rooms[0].token == value.rooms[0].token);
        let mut invalid = value.clone();
        invalid.rooms[0].token = "bad".into();
        assert!(save(root.path(), &invalid).is_err());
        assert!(fs::read(&path).unwrap() == bytes);
        let mut corrupted = bytes.clone();
        let at = corrupted.len() / 2;
        corrupted[at] ^= 1;
        fs::write(&path, &corrupted).unwrap();
        assert!(load(root.path()).is_err());
        fs::write(path, bytes).unwrap();
        assert!(load(root.path()).is_ok());
    }
}
