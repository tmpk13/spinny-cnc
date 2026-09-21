use std::process::ExitCode;

use spinny_virtual::args;

fn main() -> ExitCode {
    let options = match args::parse(std::env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => {
            print!("{}", args::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("{message}\n\n{}", args::USAGE);
            return ExitCode::from(2);
        }
    };
    match spinny_virtual::run(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spinny-virtual: {error}");
            ExitCode::FAILURE
        }
    }
}
