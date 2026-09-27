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
