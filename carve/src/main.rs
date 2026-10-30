//! spinny-carve: one JSON request on standard input (or in the file named
//! by the one argument), one JSON answer on standard output. A request that
//! cannot be met answers {"error": "..."} and exits 1.

use std::io::{Read, Write};

fn main() {
    let mut text = String::new();
    let read = match std::env::args().nth(1) {
        Some(path) if path != "-" => std::fs::read_to_string(&path).map(|t| text = t).map_err(|e| format!("cannot read {path}: {e}")),
        _ => std::io::stdin().read_to_string(&mut text).map(|_| ()).map_err(|e| format!("cannot read the request: {e}")),
    };
    let answer = read
        .and_then(|_| serde_json::from_str::<carve::plan::Request>(&text).map_err(|e| format!("the request does not read: {e}")))
        .and_then(|request| carve::plan::plan(&request));
    let (json, code) = match answer {
        Ok(response) => (serde_json::to_string(&response).expect("the answer is plain data"), 0),
        Err(error) => (serde_json::json!({ "error": error }).to_string(), 1),
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(json.as_bytes());
    let _ = out.write_all(b"\n");
    std::process::exit(code);
}
