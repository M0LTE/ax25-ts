/**
 * AX.25 amateur-radio callsign with optional Secondary Station Identifier
 * (SSID, 0-15). The base is 0-6 uppercase ASCII alphanumerics; `Parse`
 * requires at least one character.
 *
 * Mirrors `Packet.Core.Callsign` on the C# side.
 */
export class Callsign {
  /** Uppercase A-Z / 0-9, length 0-6. Empty is permitted (BPQ ID-beacon
   *  style) when constructed from wire bytes, but {@link Callsign.parse}
   *  treats empty text as an error. */
  readonly base: string;
  /** Secondary station identifier, 0-15. */
  readonly ssid: number;

  constructor(base: string, ssid = 0) {
    if (base.length > 6) {
      throw new Error(`callsign base must be 0-6 characters (got '${base}')`);
    }
    for (const c of base) {
      if (!Callsign.isValidBaseChar(c)) {
        throw new Error(`callsign base must be A-Z / 0-9 (got '${c}')`);
      }
    }
    if (ssid < 0 || ssid > 15 || !Number.isInteger(ssid)) {
      throw new Error(`SSID must be an integer 0-15 (got ${ssid})`);
    }
    this.base = base;
    this.ssid = ssid;
  }

  /** Parse the canonical text form: "BASE" or "BASE-SSID". */
  static parse(text: string): Callsign {
    const result = Callsign.tryParse(text);
    if (!result) {
      throw new Error(`invalid callsign: '${text}'`);
    }
    return result;
  }

  static tryParse(text: string | null | undefined): Callsign | null {
    if (!text) return null;
    let baseStr: string;
    let ssid = 0;
    const dash = text.indexOf("-");
    if (dash >= 0) {
      baseStr = text.substring(0, dash);
      const ssidStr = text.substring(dash + 1);
      const parsed = Number(ssidStr);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 15) {
        return null;
      }
      ssid = parsed;
    } else {
      baseStr = text;
    }
    if (baseStr.length < 1 || baseStr.length > 6) return null;
    for (const c of baseStr) {
      if (!Callsign.isValidBaseChar(c)) return null;
    }
    return new Callsign(baseStr, ssid);
  }

  toString(): string {
    return this.ssid === 0 ? this.base : `${this.base}-${this.ssid}`;
  }

  equals(other: Callsign): boolean {
    return this.base === other.base && this.ssid === other.ssid;
  }

  private static isValidBaseChar(c: string): boolean {
    if (c.length !== 1) return false;
    const code = c.charCodeAt(0);
    return (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x30 && code <= 0x39) // 0-9
    );
  }
}
