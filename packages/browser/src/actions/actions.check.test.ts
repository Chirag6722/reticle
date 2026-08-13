import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

/**
 * `check` / `uncheck` must drive the checkbox the way a user does, not assign its property.
 *
 * The old implementation was `el.checked = true; dispatchEvent(new Event('change'))`. That flips the
 * pixel and fires nothing an app actually listens to:
 *
 *   - React binds a checkbox's `onChange` to the **click** event, not `change`;
 *   - React tracks the last value it wrote, and assigning `.checked` updates that tracker, so the
 *     synthetic change it might otherwise have derived is deduped away.
 *
 * So on any controlled checkbox — `checked={state}` with `onChange={() => toggle(id)}` — the handler
 * never ran, the component's state never moved, and **the action reported success**. A tool whose
 * entire purpose is catching false greens was manufacturing one: `dispatched: true`, a visibly
 * ticked box, and an app that never heard about it.
 *
 * Reported from the field, where the agent lost calls to it and briefly suspected an app bug that
 * did not exist, then worked around it by using `click` instead — which is exactly what this now
 * does, because `HTMLElement.click()` runs the element's ACTIVATION BEHAVIOUR (the native toggle)
 * as well as firing the event, which `dispatchEvent` does not.
 */
function box(attrs: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  Object.assign(el, attrs);
  document.body.appendChild(el);
  return el;
}

describe('check/uncheck drive the control instead of assigning it', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fires a click, which is what a framework is listening to', async () => {
    const el = box();
    const seen: string[] = [];
    el.addEventListener('click', () => seen.push('click'));
    el.addEventListener('change', () => seen.push('change'));

    await executeAction(refs.refFor(el), ActionType.CHECK, {});

    expect(seen, 'a click must reach the app, not only a change').toContain('click');
    expect(el.checked).toBe(true);
  });

  it('still ends in the requested state', async () => {
    const el = box();
    await executeAction(refs.refFor(el), ActionType.CHECK, {});
    expect(el.checked).toBe(true);
    await executeAction(refs.refFor(el), ActionType.UNCHECK, {});
    expect(el.checked).toBe(false);
  });

  it('is idempotent — checking a checked box does not toggle it off', async () => {
    // The bug the naive `el.click()` fix introduces. `check` means "end up checked", not "toggle".
    const el = box({ checked: true });
    const clicks: number[] = [];
    el.addEventListener('click', () => clicks.push(1));

    await executeAction(refs.refFor(el), ActionType.CHECK, {});

    expect(el.checked, 'check on an already-checked box must leave it checked').toBe(true);
    expect(clicks, 'and must not fire a pointless click the app has to absorb').toHaveLength(0);
  });

  it('reports prevention when the app cancels the click', async () => {
    const el = box();
    el.addEventListener('click', (e) => e.preventDefault());
    const out = (await executeAction(refs.refFor(el), ActionType.CHECK, {})) as {
      effect?: { defaultPrevented?: boolean };
    };
    expect(out.effect?.defaultPrevented, 'a cancelled activation is not a successful check').toBe(
      true,
    );
    expect(el.checked, 'and the box must not end up checked').toBe(false);
  });

  it('refuses a control a real user could not operate', async () => {
    const el = box({ disabled: true });
    // Refused OUT LOUD rather than reported as done. Assigning `.checked` on a disabled box used to
    // succeed silently — a state no user could reach, returned as a green.
    await expect(executeAction(refs.refFor(el), ActionType.CHECK, {})).rejects.toThrow(/disabled/);
  });
});
