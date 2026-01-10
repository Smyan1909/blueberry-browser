import { ElementHandle } from "playwright";

/**
 * Represents the geometry of an element on the screen.
 * Used for visibility checks and coordinate-based clicking.
 */

export interface BoundingBox {
    x: number;
    y: number;

    width: number;
    height: number;

    top: number;
    right: number;
    bottom: number;
    left: number;
}

/**
 * The simplified representation of a DOM element that the LLM sees.
 * We strip away the noise and keep only what's semantically relevant.
 */

export interface DOMElementNode {
    nodeId: number;

    tagName: string;
    attributes: Record<string, string>;

    text?: string;

    children?: DOMElementNode[];

    isInteractive: boolean;

    isVisible: boolean;

    parentId?: number;
}

/**
 * The full "snapshot" of the page at a specific moment in time.
 */

export interface DOMState {

    tree: DOMElementNode;

    elementMap: Map<number, DOMElementNode>;

    selectorMap: Map<number, ElementHandle>;
}