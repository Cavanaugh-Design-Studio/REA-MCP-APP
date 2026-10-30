import { AsyncLocalStorage } from "node:async_hooks";
export const analysisExecutionContext = new AsyncLocalStorage<{
  environment: Readonly<NodeJS.ProcessEnv>;
  parent: string;
  processes?: Array<Record<string, unknown>>;
}>();
export function analysisEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "temp",
    "tmp",
    "tmpdir",
    "home",
    "userprofile",
    "localappdata",
    "appdata",
    "lang",
    "lc_all",
    "java_home",
    "rea_windows_native_dir",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined,
    ),
  );
}
