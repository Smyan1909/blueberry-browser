
interface ElementData {
    nodeId: number;
    tagName: string;
    attributes: Record<string, string>;
    text?: string;
    isInteractive: boolean;
    isVisible: boolean;
    rect: DOMRect;
    parentId?: number;
    children?: ElementData[];
}

let nodeIdCounter = 0;

const nodeMap = new Map<number, Element>();

export function buildDomTree(doHighlight: boolean = false): any {
    nodeIdCounter = 0;
    nodeMap.clear();

    if (document.getElementById('blueberry-highlight-container')) {
        document.getElementById('blueberry-highlight-container')!.remove();
    }

    const root = document.body;

    const simplifiedTree = recursiveTraverse(root);

    if (doHighlight) {
        drawHighlights();
    }

    return {
        tree: simplifiedTree,

        mapCount: nodeMap.size
    }
}

function recursiveTraverse(node: Element, parentId?: number): ElementData | null {

    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);

    const isVisible = 
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;
    
    if (!isVisible) return null;

    const isInteractive = checkInteractivity(node, style);


    let rawChildren = Array.from(node.children);
    if (node.shadowRoot) {
        rawChildren = [...rawChildren, ...Array.from(node.shadowRoot.children)];
    }

    const childrenData: ElementData[] = [];

    const currentId = ++nodeIdCounter;
    nodeMap.set(currentId, node);

    node.setAttribute('data-blueberry-id', currentId.toString());

    for (const child of Array.from(node.children)) {
        const childResult = recursiveTraverse(child, currentId);
        if (childResult) {
            childrenData.push(childResult);
        }
    }

    let text = '';


    if (isInteractive) {
        // For buttons/links, we usually want the full cleaner label
        text = node.textContent || '';
    } else {
        // For containers, we only want "own" text to avoid duplicating children's text
        node.childNodes.forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.nodeValue || '';
            }
        });
    }


    if (!isInteractive && childrenData.length === 0 && text.length === 0) return null;


    const MAX_TEXT = 6000;
    if (text.length > MAX_TEXT) {
        text = text.substring(0, MAX_TEXT) + '...[truncated]';
    }
    
    return {
        nodeId: currentId,
        tagName: node.tagName.toLowerCase(),
        attributes: getRelevantAttributes(node),
        text: text,
        isInteractive,
        isVisible,
        rect: {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
        } as any,
        parentId,
        children: childrenData.length > 0 ? childrenData : undefined,
    };
    
}

function checkInteractivity(node: Element, style: CSSStyleDeclaration): boolean {
    const tagName = node.tagName.toLowerCase();
  
    // Semantic Interactive Elements
    if (['button', 'a', 'input', 'select', 'textarea', 'details', 'summary'].includes(tagName)) return true;

    // ARIA Roles that imply interactivity
    const role = node.getAttribute('role');
    if (['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab', 'combobox', 'textbox', 'switch'].includes(role || '')) return true;

    // Event Handlers (Heuristic)
    // Note: We can't detect event listeners added via addEventListener from here easily,
    // but we can check inline handlers or cursor styles.
    if (node.hasAttribute('onclick') || node.hasAttribute('ng-click') || node.hasAttribute('@click')) return true;

    // Visual Cues
    if (style.cursor === 'pointer' || style.cursor === 'hand') return true;
    
    // Form Labels are interactive because clicking them focuses the input
    if (tagName === 'label') return true;

    return false;
}

function getRelevantAttributes(node: Element): Record<string, string> {
    const attrs: Record<string, string> = {};
  
    const core = ['id', 'class', 'name', 'type', 'placeholder', 'title', 'alt', 'href', 'src'];
    
    // Properties that should be read from the live DOM object, not attributes
    const liveProps = ['value', 'checked', 'selected', 'disabled', 'readonly'];
  
    const states = [
      'role', 
      'aria-label', 'aria-labelledby', 'aria-describedby',
      'aria-hidden', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled'
    ];
  

    [...core, ...states].forEach(attr => {
        if (node.hasAttribute(attr)) {
            attrs[attr] = node.getAttribute(attr) || '';
        }
    });

    liveProps.forEach(prop => {
        if (prop in node) {
            const val = (node as any)[prop];
            // Only add if truthy or explicitly false (for booleans)
            if (val === true) attrs[prop] = 'true';
            if (val === false) attrs[prop] = 'false';
            if (typeof val === 'string' && val.length > 0) attrs[prop] = val;
        }
    });
  
    return attrs;
}


function drawHighlights() {
    const container = document.createElement('div');
    container.id = 'blueberry-highlight-container';
    Object.assign(container.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none', // Click through
        zIndex: '2147483647', // Max z-index
    });

    nodeMap.forEach((node, id) => {

        const rect = node.getBoundingClientRect();

        if ( rect.width === 0 || rect.height === 0) return;

        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'absolute',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            border: '2px solid rgba(255, 0, 0, 0.6)',
            backgroundColor: 'rgba(255, 0, 0, 0.05)',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'start',
            justifyContent: 'start'
        });

        const label = document.createElement('span');
        label.textContent = id.toString();
        Object.assign(label.style, {
            backgroundColor: 'red',
            color: 'white',
            fontSize: '10px',
            padding: '1px 3px',
            fontWeight: 'bold'
        });

        box.appendChild(label);
        container.appendChild(box);
    });

    document.body.appendChild(container);
}