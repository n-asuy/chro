//! Optional instance lifecycle client. Configuration and keychain credentials
//! are shared with the desktop; multiple sessions never imply a default server.
use crate::args::CloudCommand;
use local_runtime::cloud::{self, CloudClient};
use reqwest::Method;
use serde_json::{json, Value};

pub fn run(command: &CloudCommand) -> anyhow::Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            if matches!(command, CloudCommand::Login) {
                cloud::sign_in().await?;
                println!("Signed in to Cloud. Credentials saved in the OS keychain.");
                return Ok(());
            }
            let client = CloudClient::connect().await?;
            let base = &client.settings.control_plane_url;
            let value: Value = match command {
                CloudCommand::Login => unreachable!(),
                CloudCommand::Up { session_id } => {
                    serde_json::to_value(client.instance(&session_id.to_string()).await?)?
                }
                CloudCommand::Status => {
                    client
                        .json(base, Method::GET, "/v1/instances", None)
                        .await?
                }
                CloudCommand::Down { instance_id } => {
                    client
                        .json(
                            base,
                            Method::POST,
                            &format!(
                                "/v1/instances/{}/sleep",
                                form_urlencoded::byte_serialize(instance_id.as_bytes())
                                    .collect::<String>()
                            ),
                            Some(json!({})),
                        )
                        .await?
                }
                CloudCommand::Destroy { instance_id } => {
                    client
                        .request(
                            base,
                            Method::DELETE,
                            &format!(
                                "/v1/instances/{}",
                                form_urlencoded::byte_serialize(instance_id.as_bytes())
                                    .collect::<String>()
                            ),
                            None,
                        )
                        .await?;
                    json!({"destroying": instance_id})
                }
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        })
}
