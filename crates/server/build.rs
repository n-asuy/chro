use std::fs;
use std::path::Path;

fn main() {
    let dist_path = Path::new("../../apps/desktop/dist-vite");
    if !dist_path.exists() {
        fs::create_dir_all(dist_path).unwrap();
        let placeholder = r#"<!DOCTYPE html>
<html><head><title>Build frontend first</title></head>
<body><h1>Please build the frontend first</h1>
<p>Run: bun run --filter=@chro/desktop build</p></body></html>"#;
        fs::write(dist_path.join("index.html"), placeholder).unwrap();
    }
}
