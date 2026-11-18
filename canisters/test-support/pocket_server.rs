use std::{fs, path::PathBuf};
pub struct Server {
    child: std::process::Child,
    port: PathBuf,
    pub url: String,
}
impl Server {
    pub fn start() -> Self {
        let binary = std::env::var_os("POCKET_IC_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("pocket-ic-server-15.0.0/pocket-ic"));
        let version = std::process::Command::new(&binary)
            .arg("--version")
            .output()
            .expect("PocketIC 15 binary required");
        assert!(String::from_utf8_lossy(&version.stdout).contains("15.0."));
        let port = std::env::temp_dir().join(format!("ticketing-{}.port", std::process::id()));
        let _ = fs::remove_file(&port);
        let child = std::process::Command::new(binary)
            .args([
                "--ip-addr",
                "127.0.0.1",
                "--ttl",
                "120",
                "--log-levels",
                "error",
                "--port-file",
            ])
            .arg(&port)
            .spawn()
            .unwrap();
        let mut s = Self {
            child,
            port,
            url: String::new(),
        };
        for _ in 0..600 {
            if let Ok(port) = fs::read_to_string(&s.port) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    s.url = format!("http://127.0.0.1:{port}");
                    return s;
                }
            }
            assert!(s.child.try_wait().unwrap().is_none());
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("PocketIC startup timeout")
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.port);
    }
}
