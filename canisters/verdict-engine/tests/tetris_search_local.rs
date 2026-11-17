//! Disposable frozen-Wasm query target for the placement study. No production access.
use candid::{Decode, Encode, Principal};
use ic_laya_core::{Result, SpecialTokens};
use pocket_ic::PocketIcBuilder;
use std::{fs, io::{self, BufRead}, path::PathBuf};

#[test]
#[ignore = "requires PocketIC 15, frozen compatibility Wasm, and the real local model pack"]
fn serve_tetris_search_model() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    // The library's implicit server has a 600-second hard TTL. Own this server
    // explicitly so a complete experiment can run longer and is cleaned up.
    let server = LocalServer::start();
    let mut pic = PocketIcBuilder::new().with_server_url(server.url.parse().unwrap()).with_application_subnet().build();
    let owner = Principal::self_authenticating(b"tetris-search-disposable-local-owner");
    let id = pic.create_canister();
    pic.add_cycles(id, 10_000_000_000_000_000);
    let wasm = fs::read(root.join("build/compat-model-query/verdict-engine.wasm")).unwrap();
    let hash = ic_laya_core::hash(&wasm).iter().map(|b|format!("{b:02x}")).collect::<String>();
    assert_eq!(hash,"584657715086775ff0e785053b175c777d27261abd13029b71bc1aeeb662204e");
    pic.install_canister(id, wasm, Encode!(&owner).unwrap(), None);
    let call = |method: &str, args| pic.update_call(id, owner, method, args).unwrap();
    let manifest = fs::read(root.join("models/verdict-pack/manifest.json")).unwrap();
    let tokenizer = fs::read(root.join("models/verdict-151m/tokenizer.json")).unwrap();
    let special = SpecialTokens {cls:50281,sep:50282,mask:50284,pad:50283,literals:vec!["[CLS]".into(),"[SEP]".into(),"[MASK]".into(),"[PAD]".into()]};
    Decode!(&call("begin_upload", Encode!(&manifest, &(tokenizer.len() as u64), &special).unwrap()), Result<[u8;32]>).unwrap().unwrap();
    let mut bytes=fs::read(root.join("models/verdict-pack/model.bin")).unwrap();bytes.extend(tokenizer);
    for (index,chunk) in bytes.chunks(1024*1024).enumerate() {
        Decode!(&call("upload_chunk", Encode!(&(index as u64*1024*1024), &chunk.to_vec()).unwrap()), Result<u64>).unwrap().unwrap();
    }
    drop(bytes);
    Decode!(&call("start_warmup", Encode!().unwrap()), Result<u64>).unwrap().unwrap();
    let mut warmed=false;
    for _ in 0..200 {if Decode!(&call("warmup_next", Encode!().unwrap()), Result<bool>).unwrap().unwrap(){warmed=true;break;}}
    assert!(warmed);
    Decode!(&call("set_cost_model", Encode!(&170_000_000u64,&92_000_000u64,&40_000_000_000u64).unwrap()),Result<()>).unwrap().unwrap();
    let host=pic.make_live(None).to_string();
    fs::create_dir_all(root.join("artifacts/tetris-search")).unwrap();
    fs::write(root.join("artifacts/tetris-search/local-target.json"),serde_json::to_vec_pretty(&serde_json::json!({"host":host,"canister":id.to_text(),"wasm_sha256":"584657715086775ff0e785053b175c777d27261abd13029b71bc1aeeb662204e","replica":"PocketIC 15, application subnet, disposable instance","model_pack_sha256":ic_laya_core::hash(&manifest)})).unwrap()).unwrap();
    println!("READY: {host} / {id}; close stdin to remove the disposable instance");
    let (send, receive)=std::sync::mpsc::channel();
    std::thread::spawn(move || {for line in io::stdin().lock().lines(){if line.unwrap()=="stop"{break;}}let _=send.send(());});
    while receive.recv_timeout(std::time::Duration::from_secs(10)).is_err(){let _=pic.get_time();}
    pic.stop_live();
}

struct LocalServer { child: std::process::Child, port: PathBuf, url: String }
impl LocalServer {
    fn start() -> Self {
        let binary=std::env::var_os("POCKET_IC_BIN").expect("set POCKET_IC_BIN to PocketIC 15");
        let version=std::process::Command::new(&binary).arg("--version").output().unwrap();
        assert!(String::from_utf8_lossy(&version.stdout).contains("15.0."));
        let port=std::env::temp_dir().join(format!("openjev-tetris-search-{}.port",std::process::id()));
        let _=fs::remove_file(&port);
        let child=std::process::Command::new(binary).args(["--ip-addr","127.0.0.1","--ttl","120","--log-levels","error","--port-file"]).arg(&port).spawn().unwrap();
        let mut server=Self{child,port,url:String::new()};
        for _ in 0..600 {
            if let Ok(value)=fs::read_to_string(&server.port) {
                if let Ok(port)=value.trim().parse::<u16>() {server.url=format!("http://127.0.0.1:{port}");return server;}
            }
            assert!(server.child.try_wait().unwrap().is_none(),"PocketIC exited before startup");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("PocketIC did not start within 30 seconds");
    }
}
impl Drop for LocalServer {
    fn drop(&mut self) {let _=self.child.kill();let _=self.child.wait();let _=fs::remove_file(&self.port);}
}
