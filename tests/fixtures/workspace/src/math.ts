/**
 * 两数相加。
 * @param a 左值
 * @returns 和
 */
export function add(a: number, b: number): number {
  return a + b;
}

export interface UserProfile {
  id: string;
  displayName: string;
}

export function greeting(user: UserProfile): string {
  return `hello ${user.displayName}`;
}
