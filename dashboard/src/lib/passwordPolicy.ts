/*
 * Mirror of src/anpr/security/passwords.py, for live feedback only. The server applies the
 * same rules and is the one that decides.
 */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;
const COMMON = new Set(["password1234", "123456789012", "qwertyuiopas", "administrator", "changemenow!", "letmein12345"]);

export interface PolicyCheck {
  label: string;
  ok: boolean;
}

export function passwordChecks(password: string, username: string): PolicyCheck[] {
  return [
    { label: `At least ${MIN_PASSWORD} characters`, ok: password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD },
    { label: "Does not contain the username", ok: !username || !password.toLowerCase().includes(username.toLowerCase()) },
    { label: "More than 3 different characters", ok: new Set(password).size >= 4 },
    { label: "Not a common password", ok: !COMMON.has(password.toLowerCase()) },
  ];
}

export const passwordOk = (password: string, username: string) => passwordChecks(password, username).every((c) => c.ok);

/** 20 random characters from an unambiguous alphabet, using the browser's CSPRNG. */
export function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%";
  const limit = 256 - (256 % alphabet.length); // reject bytes that would bias the choice
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
