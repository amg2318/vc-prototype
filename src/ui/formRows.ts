/** Small form helpers shared by the drawing page's popovers. */

/** A labelled row: name, control and an optional value readout. */
export function row(labelText: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  label.className = 'row';
  const name = document.createElement('span');
  name.textContent = labelText;
  label.append(name, control);
  if (value) label.append(value);
  return label;
}

/** A row of plain buttons. */
export function buttons(items: [string, () => void][]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'buttons';
  for (const [text, onClick] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    wrap.append(b);
  }
  return wrap;
}

/** A checkbox row that isn't bound to brush settings. */
export function checkboxRow(labelText: string, initial: boolean, onChange: (v: boolean) => void): { element: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  input.addEventListener('change', () => onChange(input.checked));
  return { element: row(labelText, input), input };
}

/** The design's visibility checkbox: checked = shown. A label wraps it so the touch target is 44 px. */
export function visibilityCheckbox(checked: boolean, onChange: (visible: boolean) => void): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'layer-visible';
  label.title = checked ? 'Shown (tap to hide)' : 'Hidden (tap to show)';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked });
  input.setAttribute('aria-label', 'Visible');
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input);
  return label;
}

/** Show/hide for the popovers opened from the top bar and the tool rail. */
export class Popover {
  readonly element: HTMLElement;

  constructor(className: string) {
    this.element = document.createElement('div');
    this.element.className = `${className} panel popover`;
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }
}
