import { randomUUID } from 'node:crypto';

/** 短 UUID，兼顾可读性与碰撞概率（122 bit 熵） */
export function newId(): string {
  return randomUUID();
}
