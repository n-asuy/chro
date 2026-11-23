// `sqlx::migrate!` embeds the migrations directory at compile time, but Cargo
// only tracks files it already knows about. Without this, adding a new
// migration file reuses the stale embedded list and the server starts against
// a schema that is missing the new tables.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
