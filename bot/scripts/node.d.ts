// The few Node.js APIs the scripts use. @types/node is not a dependency; the
// Worker code must not use these.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
};

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function existsSync(path: string | URL): boolean;
}

interface ImportMeta {
  url: string;
}

declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: string[],
    options: { encoding: "utf8"; stdio: Array<"ignore" | "pipe"> },
  ): { status: number | null; stdout: string };
}
