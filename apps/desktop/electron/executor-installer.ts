import { spawn } from "node:child_process";

export type DesktopExecutor = "CLAUDE_CODE" | "CODEX";

export type ExecutorInstallResult = {
  ok: boolean;
  executor: DesktopExecutor;
  command: string;
  strategy: string;
  stdout: string;
  stderr: string;
  message: string;
};

type ShellCommandResult = {
  stdout: string;
  stderr: string;
};

type RunShellCommandOptions = {
  logLabel?: string;
};

class ShellCommandError extends Error {
  stdout: string;
  stderr: string;

  constructor(message: string, output?: Partial<ShellCommandResult>) {
    super(message);
    this.name = "ShellCommandError";
    this.stdout = output?.stdout ?? "";
    this.stderr = output?.stderr ?? "";
  }
}

type InstallStrategy = {
  command: string;
  label: string;
};

const hasLoginShell = (shellPath: string) =>
  shellPath.endsWith("/zsh") ||
  shellPath.endsWith("/bash") ||
  shellPath.endsWith("/fish");

const runShellCommand = async (
  command: string,
  options?: RunShellCommandOptions,
): Promise<ShellCommandResult> => {
  const logLabel = options?.logLabel;

  if (process.platform === "win32") {
    if (logLabel) {
      console.log(`[install:${logLabel}] $ ${command}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (logLabel) {
          process.stdout.write(text);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (logLabel) {
          process.stderr.write(text);
        }
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (code === 0) {
          if (logLabel) {
            console.log(`[install:${logLabel}] completed successfully`);
          }
          resolve({ stdout, stderr });
          return;
        }

        if (logLabel) {
          console.error(
            `[install:${logLabel}] exited with code ${code ?? "unknown"}`,
          );
        }
        reject(
          new ShellCommandError(
            stderr.trim() ||
              stdout.trim() ||
              `Installer exited with code ${code ?? "unknown"}`,
            { stdout, stderr },
          ),
        );
      });
    });
  }

  const shellPath =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const shellArgs = hasLoginShell(shellPath)
    ? ["-lc", command]
    : ["-c", command];

  if (logLabel) {
    console.log(`[install:${logLabel}] $ ${command}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(shellPath, shellArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (logLabel) {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (logLabel) {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        if (logLabel) {
          console.log(`[install:${logLabel}] completed successfully`);
        }
        resolve({ stdout, stderr });
        return;
      }

      if (logLabel) {
        console.error(
          `[install:${logLabel}] exited with code ${code ?? "unknown"}`,
        );
      }
      reject(
        new ShellCommandError(
          stderr.trim() ||
            stdout.trim() ||
            `Installer exited with code ${code ?? "unknown"}`,
          { stdout, stderr },
        ),
      );
    });
  });
};

const commandExists = async (command: string): Promise<boolean> => {
  try {
    if (process.platform === "win32") {
      await runShellCommand(`Get-Command ${command} | Out-Null`);
    } else {
      await runShellCommand(`command -v ${command} >/dev/null 2>&1`);
    }
    return true;
  } catch {
    return false;
  }
};

const getInstallStrategy = async (
  executor: DesktopExecutor,
): Promise<InstallStrategy> => {
  switch (executor) {
    case "CLAUDE_CODE": {
      if (process.platform === "win32") {
        if (await commandExists("npm")) {
          return {
            label: "npm",
            command: "npm install -g @anthropic-ai/claude-code",
          };
        }

        throw new Error(
          "Automatic install requires npm on Windows. Open the install guide to continue manually.",
        );
      }

      if (await commandExists("curl")) {
        return {
          label: "official installer",
          command: "curl -fsSL https://claude.ai/install.sh | bash",
        };
      }

      if (await commandExists("npm")) {
        return {
          label: "npm",
          command: "npm install -g @anthropic-ai/claude-code",
        };
      }

      throw new Error(
        "Automatic install requires curl or npm. Open the install guide to continue manually.",
      );
    }
    case "CODEX": {
      if (process.platform === "darwin" && (await commandExists("brew"))) {
        return {
          label: "Homebrew",
          command: "brew install --cask codex",
        };
      }

      if (await commandExists("npm")) {
        return {
          label: "npm",
          command: "npm install -g @openai/codex",
        };
      }

      throw new Error(
        "Automatic install requires Homebrew or npm. Open the install guide to continue manually.",
      );
    }
  }
};

export const installExecutor = async (
  executor: DesktopExecutor,
): Promise<ExecutorInstallResult> => {
  let strategy: InstallStrategy | null = null;

  try {
    strategy = await getInstallStrategy(executor);
    const output = await runShellCommand(strategy.command, {
      logLabel: executor,
    });

    return {
      ok: true,
      executor,
      command: strategy.command,
      strategy: strategy.label,
      stdout: output.stdout.trim(),
      stderr: output.stderr.trim(),
      message: `Installed via ${strategy.label}.`,
    };
  } catch (error) {
    const stdout =
      error instanceof ShellCommandError ? error.stdout.trim() : "";
    const stderr =
      error instanceof ShellCommandError ? error.stderr.trim() : "";

    return {
      ok: false,
      executor,
      command: strategy?.command ?? "",
      strategy: strategy?.label ?? "",
      stdout,
      stderr,
      message: error instanceof Error ? error.message : "Installation failed.",
    };
  }
};
