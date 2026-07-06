//! Auto-provision the pieces the driver needs so it is a single self-contained
//! binary: run it with no paths and it fetches the pinned ya-runtime-vm release
//! and the published provider image into a cache directory.
//!
//! The image is content-addressed — its Golem SDK hash is the SHA3-224 of the
//! .gvmi file — so the download is verified against the hash before it is used.

use anyhow::{anyhow, bail, Context as _};
use serde_json::Value;
use sha3::{Digest, Sha3_224};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Provider image published by the `Build provider GVMI image` GitHub action
/// (VOLUME /exchange, root user). Overridable with `--image-hash`.
pub const DEFAULT_IMAGE_HASH: &str = "044d796c034769b89b471d518f4e998f2ded965e997cb880681c0b16";

/// ya-runtime-vm release whose bundled ya-runtime-api rev this driver pins.
pub const DEFAULT_RUNTIME_URL: &str =
    "https://github.com/golemfactory/ya-runtime-vm/releases/download/v0.5.3/ya-runtime-vm-linux-v0.5.3.tar.gz";

const REGISTRY_INFO: &str = "https://registry.golem.network/v1/image/info";

/// `$XDG_CACHE_HOME/atlas-vm-driver` or `~/.cache/atlas-vm-driver`.
pub fn default_cache_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CACHE_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(x).join("atlas-vm-driver");
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".cache").join("atlas-vm-driver")
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Stream `url` into `dest` atomically (.part → rename), verifying the byte
/// count against Content-Length and, when given, the SHA3-224 against `sha3`.
fn download(url: &str, dest: &Path, sha3: Option<&str>) -> anyhow::Result<()> {
    let resp = ureq::get(url).call().map_err(|e| anyhow!("GET {url}: {e}"))?;
    let expected_len: Option<u64> = resp.header("content-length").and_then(|v| v.parse().ok());
    let tmp = dest.with_extension("part");
    let mut reader = resp.into_reader();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?,
    );
    let mut hasher = Sha3_224::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf).with_context(|| format!("reading {url}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])?;
        total += n as u64;
    }
    file.flush()?;
    drop(file);
    if let Some(exp) = expected_len {
        if exp != total {
            let _ = std::fs::remove_file(&tmp);
            bail!("download truncated: got {total} of {exp} bytes from {url}");
        }
    }
    if let Some(want) = sha3 {
        let got = hex(&hasher.finalize());
        if !got.eq_ignore_ascii_case(want) {
            let _ = std::fs::remove_file(&tmp);
            bail!("image hash mismatch for {url}: got {got}, expected {want}");
        }
    }
    std::fs::rename(&tmp, dest).with_context(|| format!("installing {}", dest.display()))?;
    Ok(())
}

/// Ensure the provider .gvmi for `hash` is cached; download+verify if not.
pub fn ensure_image(cache: &Path, hash: &str) -> anyhow::Result<PathBuf> {
    let dest = cache.join(format!("{hash}.gvmi"));
    if dest.exists() {
        // present ⇒ verified (download only renames into place after the hash
        // matches), so trust it without re-hashing on every run
        println!("[driver] image cached: {}", dest.display());
        return Ok(dest);
    }
    let info: Value = ureq::get(REGISTRY_INFO)
        .query("hash", hash)
        .call()
        .map_err(|e| anyhow!("resolving image {hash}: {e}"))?
        .into_json()
        .context("parsing registry image info")?;
    let url = info["https"]
        .as_str()
        .or_else(|| info["http"].as_str())
        .ok_or_else(|| anyhow!("registry returned no download URL for {hash}: {info}"))?;
    let size = info["size"].as_u64().unwrap_or(0);
    println!("[driver] downloading image {hash} ({size} bytes) …");
    download(url, &dest, Some(hash))?;
    println!("[driver] image ready: {}", dest.display());
    Ok(dest)
}

/// Ensure the ya-runtime-vm binary from `url` is cached; download+extract if
/// not. The tarball's own tree is kept (vmrt locates the kernel/vmrt binary
/// relative to it), and the extract dir is keyed by the tarball name so
/// different runtime versions can coexist.
pub fn ensure_runtime(cache: &Path, url: &str) -> anyhow::Result<PathBuf> {
    let name = url.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("ya-runtime-vm.tar.gz");
    let stem = name.trim_end_matches(".tar.gz").trim_end_matches(".tgz");
    let extract_dir = cache.join(stem);
    if let Some(bin) = find_binary(&extract_dir) {
        println!("[driver] runtime cached: {}", bin.display());
        return Ok(bin);
    }
    let tarball = cache.join(name);
    if !tarball.exists() {
        println!("[driver] downloading runtime {name} …");
        download(url, &tarball, None)?;
    }
    std::fs::create_dir_all(&extract_dir)?;
    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&tarball)
        .arg("-C")
        .arg(&extract_dir)
        .status()
        .context("running `tar` to extract the runtime (is tar installed?)")?;
    if !status.success() {
        bail!("tar failed to extract {}", tarball.display());
    }
    let bin = find_binary(&extract_dir)
        .ok_or_else(|| anyhow!("no ya-runtime-vm binary found after extracting {}", tarball.display()))?;
    println!("[driver] runtime ready: {}", bin.display());
    Ok(bin)
}

/// Depth-first search for the regular file named `ya-runtime-vm` (the tarball
/// nests it under a same-named directory).
fn find_binary(dir: &Path) -> Option<PathBuf> {
    let mut found = None;
    fn walk(dir: &Path, found: &mut Option<PathBuf>) {
        if found.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                walk(&p, found);
            } else if ft.is_file() && p.file_name().and_then(|n| n.to_str()) == Some("ya-runtime-vm") {
                *found = Some(p);
                return;
            }
        }
    }
    walk(dir, &mut found);
    found
}
