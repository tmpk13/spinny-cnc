import { afterEach, expect, test } from "bun:test";
import { anyPopUp, popUp } from "../src/dismiss.ts";
import { closeMenu, menuOpen, openMenu } from "../src/menu.ts";

afterEach(() => {
    closeMenu(false);
    document.body.replaceChildren();
});

function press(node: Element): { pointer: PointerEvent; clicked: boolean } {
    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    node.dispatchEvent(pointer);
    node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const clicked = node.dispatchEvent(click);
    return { pointer, clicked };
}

function setup(): { pop: HTMLElement; opener: HTMLButtonElement; other: HTMLButtonElement; stop: HTMLButtonElement; pressed: string[] } {
    const pressed: string[] = [];
    const pop = document.createElement("div");
    pop.append(Object.assign(document.createElement("button"), { textContent: "inside" }));
    const opener = Object.assign(document.createElement("button"), { textContent: "opener" });
    const other = Object.assign(document.createElement("button"), { textContent: "Run" });
    const stop = Object.assign(document.createElement("button"), { textContent: "Stop", className: "btn btn-danger btn-stop" });
    for (const button of [other, stop, pop.firstElementChild as HTMLButtonElement]) {
        button.addEventListener("click", () => pressed.push(button.textContent ?? ""));
    }
    document.body.append(pop, opener, other, stop);
    return { pop, opener, other, stop, pressed };
}

test("a pop-up marks the page and itself until it lets go", () => {
    const { pop, opener } = setup();
    const release = popUp({ nodes: () => [pop, opener], close: () => release() });
    expect(document.documentElement.hasAttribute("data-dismiss")).toBe(true);
    expect(pop.hasAttribute("data-popup")).toBe(true);
    expect(opener.hasAttribute("data-popup")).toBe(true);
    expect(anyPopUp()).toBe(true);
    release();
    expect(document.documentElement.hasAttribute("data-dismiss")).toBe(false);
    expect(pop.hasAttribute("data-popup")).toBe(false);
    expect(anyPopUp()).toBe(false);
});

test("a press outside only takes the pop-up away: the button under it is not pressed", () => {
    const { pop, opener, other, pressed } = setup();
    let closed = 0;
    const release = popUp({ nodes: () => [pop, opener], close: () => {
        closed += 1;
        release();
    } });
    const { pointer, clicked } = press(other);
    expect(closed).toBe(1);
    expect(pointer.defaultPrevented).toBe(true);
    expect(clicked).toBe(false);
    expect(pressed).toEqual([]);
    // With the pop-up gone, the next press is a press.
    press(other);
    expect(pressed).toEqual(["Run"]);
});

test("a press inside the pop-up or on its opener is the pop-up's own", () => {
    const { pop, opener, pressed } = setup();
    let closed = 0;
    const release = popUp({ nodes: () => [pop, opener], close: () => {
        closed += 1;
        release();
    } });
    press(pop.firstElementChild!);
    press(opener);
    expect(closed).toBe(0);
    expect(pressed).toEqual(["inside"]);
    release();
});

test("a stop button is always pressed, and takes the pop-up away", () => {
    const { pop, opener, stop, pressed } = setup();
    let closed = 0;
    const release = popUp({ nodes: () => [pop, opener], close: () => {
        closed += 1;
        release();
    } });
    const { pointer } = press(stop);
    expect(closed).toBe(1);
    expect(pointer.defaultPrevented).toBe(false);
    expect(pressed).toEqual(["Stop"]);
});

test("an open menu is a pop-up: a press elsewhere closes it and goes no further", () => {
    const { other, opener, pressed } = setup();
    let ran = false;
    openMenu([{ label: "Fold", run: () => (ran = true) }], opener, "Panel");
    expect(menuOpen()).toBe(true);
    expect(document.documentElement.hasAttribute("data-dismiss")).toBe(true);
    press(other);
    expect(menuOpen()).toBe(false);
    expect(ran).toBe(false);
    expect(pressed).toEqual([]);
    expect(document.documentElement.hasAttribute("data-dismiss")).toBe(false);
});

test("a pop-up whose nodes left the page holds back no press", () => {
    const { pop, opener, other, pressed } = setup();
    popUp({ nodes: () => [pop, opener], close: () => undefined });
    pop.remove();
    opener.remove();
    press(other);
    expect(pressed).toEqual(["Run"]);
    expect(document.documentElement.hasAttribute("data-dismiss")).toBe(false);
});

test("a red button that starts something is held back like any other; one that stops is not", () => {
    const { pop, opener } = setup();
    const pressed: string[] = [];
    const fire = Object.assign(document.createElement("button"), { textContent: "Test beam", className: "btn btn-danger btn-big" });
    const hold = Object.assign(document.createElement("button"), { textContent: "Hold", className: "btn urgent" });
    for (const button of [fire, hold]) {
        button.addEventListener("click", () => pressed.push(button.textContent ?? ""));
        document.body.append(button);
    }
    const open = (): (() => void) => {
        const release = popUp({ nodes: () => [pop, opener], close: () => release() });
        return release;
    };
    open();
    press(fire);
    expect(pressed).toEqual([]);
    open();
    press(hold);
    expect(pressed).toEqual(["Hold"]);
});
