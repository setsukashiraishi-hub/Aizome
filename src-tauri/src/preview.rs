// プレビュー：HTML や Markdown を、ページとして見せる
// 画面の中の iframe に aizpv://localhost/<id>/index.html（Windows は http://aizpv.localhost/…）を出す。
// index.html は編集中の内容（保存していなくても）、それ以外（style.css や画像）は、そのファイルのフォルダから読む。
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

#[derive(Default)]
pub struct PreviewState(Mutex<HashMap<String, Page>>);

struct Page {
    html: String,
    dir: PathBuf,
    /// 読んでよい範囲（開いているフォルダ。なければファイルのフォルダ）
    base: PathBuf,
}

#[tauri::command]
pub fn preview_set(state: tauri::State<'_, PreviewState>, id: String, html: String, dir: String, root: Option<String>) {
    let dir = PathBuf::from(dir);
    let base = root
        .map(PathBuf::from)
        .filter(|r| !r.as_os_str().is_empty() && dir.starts_with(r))
        .unwrap_or_else(|| dir.clone());
    let dir = dir.canonicalize().unwrap_or(dir);
    let base = base.canonicalize().unwrap_or(base);
    if let Ok(mut map) = state.0.lock() {
        map.insert(id, Page { html, dir, base });
    }
}

/// 保存してあるファイルを、いつものブラウザ（その種類のファイルを開くアプリ）で開く
#[tauri::command]
pub fn preview_open_external(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("ファイルが見つかりません（先に保存してください）".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(p)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(p).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(p).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("txt") | Some("md") | Some("csv") => "text/plain; charset=utf-8",
        Some("xml") => "application/xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn reply(status: StatusCode, kind: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = decode(req.uri().path());
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let id = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("").to_string();
    let state = ctx.app_handle().state::<PreviewState>();
    let map = match state.0.lock() {
        Ok(m) => m,
        Err(_) => return reply(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new()),
    };
    let Some(page) = map.get(&id) else {
        return reply(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "preview not found".into());
    };
    if rest.is_empty() || rest == "index.html" || rest == "__aizome_preview__.html" {
        return reply(StatusCode::OK, "text/html; charset=utf-8", page.html.clone().into_bytes());
    }
    // そのファイルのフォルダから読む（開いているフォルダの外は読まない）
    let file = page.dir.join(rest.replace('\\', "/"));
    let Ok(real) = file.canonicalize() else {
        return reply(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found".into());
    };
    if !real.starts_with(&page.base) || !real.is_file() {
        return reply(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found".into());
    }
    match std::fs::metadata(&real) {
        Ok(m) if m.len() > 200 * 1024 * 1024 => return reply(StatusCode::PAYLOAD_TOO_LARGE, "text/plain", Vec::new()),
        _ => {}
    }
    match std::fs::read(&real) {
        Ok(body) => reply(StatusCode::OK, mime(&real), body),
        Err(_) => reply(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found".into()),
    }
}
