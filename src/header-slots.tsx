import type React from "react";
import { createPortal } from "react-dom";
export type HeaderSlots = { status: HTMLElement | null; tools: HTMLElement | null };
export const inSlot = (node: React.ReactNode, slot: HTMLElement | null | undefined) => (slot ? createPortal(node, slot) : null);
