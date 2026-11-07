import { APP_VERSION, PYODIDE_URL } from "./config.js";

const FILES = [
  "__init__.py",
  "registry.py",
  "runtime.py",
  "subagents.py",
  "tools_memory.py",
  "tools_todo.py",
  "tools_extra.py",
  "compression.py",
  "connectors.py",
  "results.py",
  "passive_skills.py",
  "tools_routines.py",
  "agent.py"
];

export async function loadAgent() {
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PYODIDE_URL;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  const pyodide = await loadPyodide();
  pyodide.FS.mkdirTree("/home/pyodide/eco");
  for (const file of FILES) {
    const response = await fetch("py/eco/" + file + "?v=" + APP_VERSION);
    if (!response.ok) {
      throw new Error(file);
    }
    pyodide.FS.writeFile("/home/pyodide/eco/" + file, await response.text());
  }
  await pyodide.runPythonAsync("import sys; sys.path.insert(0, '/home/pyodide'); from eco.agent import run_turn; from eco.subagents import job_control");
  return pyodide;
}
