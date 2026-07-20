use clap::{Arg, Command};

fn build_cli() -> Command {
    Command::new(env!("CARGO_PKG_NAME"))
        .subcommand_required(true)
        .subcommand(
            Command::new("completions")
                .about("Generate shell completions")
                .arg(
                    Arg::new("shell")
                        .value_name("SHELL")
                        .help("The shell to generate the completions for")
                        .required(true)
                        .value_parser(
                            clap::builder::EnumValueParser::<clap_complete_command::Shell>::new(),
                        ),
                ),
        )
}

fn main() {
    let matches = build_cli().get_matches();

    match matches.subcommand() {
        Some(("completions", sub_matches)) => {
            if let Some(shell) = sub_matches.get_one::<clap_complete_command::Shell>("shell") {
                let mut command = build_cli();
                shell.generate(&mut command, &mut std::io::stdout());
            }
        }
        _ => {
            unreachable!("Exhausted list of subcommands and `subcommand_required` prevents `None`")
        }
    }
}
