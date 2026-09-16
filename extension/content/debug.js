(() => {
  const PCP = (globalThis.PCP ??= {});

  const LOG_LIMIT = 50;
  const frameLabel = window === window.top ? "top" : "iframe";
  const logs = [];

  function format(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  PCP.frameLabel = frameLabel;
  PCP.logs = logs;
  PCP.log = (...args) => {
    console.log(`[PrimeCatParty:${frameLabel}]`, ...args);
    logs.push(`${new Date().toLocaleTimeString("tr-TR")} ${args.map(format).join(" ")}`);
    if (logs.length > LOG_LIMIT) logs.shift();
  };
})();
