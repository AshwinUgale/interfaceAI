/** Minimal CLI arg parser: supports --k v, --k=v, boolean flags, and repeatable --input k=v. */
export function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; inputs: Record<string, string> } {
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    let key: string;
    let val: string | boolean;
    if (body.includes('=')) {
      const idx = body.indexOf('=');
      key = body.slice(0, idx);
      val = body.slice(idx + 1);
    } else {
      key = body;
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith('--')) {
        val = nxt;
        i++;
      } else {
        val = true;
      }
    }
    if (key === 'input' && typeof val === 'string' && val.includes('=')) {
      const [k, v] = val.split('=');
      inputs[k!] = v!;
    } else {
      flags[key] = val;
    }
  }
  return { flags, inputs };
}

export function str(flags: Record<string, string | boolean>, key: string, def: string): string {
  const v = flags[key];
  return typeof v === 'string' ? v : def;
}
