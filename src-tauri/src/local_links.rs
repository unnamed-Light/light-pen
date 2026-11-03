use std::path::Path;

/// Validate before touching the filesystem, so an untrusted board cannot probe UNC shares.
pub fn validate_local_document(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(p))
                if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
                    && path.is_absolute() => {}
            _ => return Err("Ссылка должна вести на документ на локальном диске.".into()),
        }
        let value = path.to_string_lossy();
        // Prevent alternate data streams and shell namespace paths.
        if value.chars().filter(|c| *c == ':').count() != 1 {
            return Err("Недопустимый путь документа.".into());
        }
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "pdf", "txt", "md", "csv", "tsv", "json", "png", "jpg", "jpeg", "webp", "gif", "bmp",
        "svg", "docx", "xlsx", "pptx", "odt", "ods", "odp", "mp3", "wav", "ogg", "flac", "m4a",
        "mp4", "webm", "mov", "mkv",
    ]
    .contains(&extension.as_str())
    {
        return Err("По ссылке можно открыть документ, изображение или медиафайл. Исполняемые файлы и ярлыки не открываются.".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_and_shell_links_are_rejected_without_accessing_the_file() {
        for ext in [
            "exe", "bat", "cmd", "ps1", "lnk", "url", "vbs", "js", "hta", "msi", "dll", "scf",
        ] {
            assert!(
                validate_local_document(Path::new(&format!(r"C:\Files\document.{ext}"))).is_err()
            );
        }
        assert!(validate_local_document(Path::new(r"C:\Files\document.pdf")).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn remote_device_relative_and_stream_paths_are_rejected_before_io() {
        for path in [
            r"\\server\share\document.pdf",
            r"\\?\UNC\server\share\document.pdf",
            r"\\.\pipe\document.pdf",
            r"document.pdf",
            r"C:document.pdf",
            r"C:\Files\document.txt:secret.pdf",
        ] {
            assert!(validate_local_document(Path::new(path)).is_err(), "{path}");
        }
    }
}
