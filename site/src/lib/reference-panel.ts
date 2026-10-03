// The Reference as an overlay panel, only while the world runs (mount.ts). The section and the footer are moved into a modal <dialog> that
// slides in from the right when a Reference link or button is pressed; the world keeps drawing behind it. Without the world (fallback tier, no JS)
// this module never loads and the Reference stays the last section of the page. dispose() puts everything back where it was.
import type { Scroll } from './scroll';

const OPENERS = '[data-open-reference], a[href="#reference"], a[href^="#ref-"]';

export function mountReferencePanel(scroll: Scroll): () => void {
  const ref = document.getElementById('reference');
  const footer = document.querySelector<HTMLElement>('body > footer');
  if (!ref) return () => {};
  const refHome = [ref.parentNode!, ref.nextSibling] as const;
  const footerHome = footer ? ([footer.parentNode!, footer.nextSibling] as const) : null;

  const dialog = document.createElement('dialog');
  dialog.className = 'ref-dialog';
  dialog.setAttribute('aria-labelledby', 'reference-title');
  dialog.setAttribute('data-lenis-prevent', ''); // Lenis leaves wheel and touch inside the panel to the browser
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn ref-close';
  close.textContent = 'Close';
  dialog.append(close, ref);
  if (footer) dialog.append(footer);
  document.body.append(dialog);

  document.querySelectorAll<HTMLElement>('a[href="#reference"], [data-open-reference]').forEach((el) => el.setAttribute('aria-haspopup', 'dialog'));

  let opener: Element | null = null;
  let closing = 0;
  const open = (id?: string) => {
    clearTimeout(closing);
    if (!dialog.open) {
      opener = document.activeElement;
      dialog.showModal();
      scroll.lock('panel');
      requestAnimationFrame(() => dialog.classList.add('is-in')); // the slide runs from the first painted frame
    }
    dialog.scrollTop = 0;
    const target = id && id !== 'reference' ? document.getElementById(id) : null;
    if (target && dialog.contains(target)) target.scrollIntoView({ block: 'start' });
  };
  const shut = () => {
    if (!dialog.open || !dialog.classList.contains('is-in')) return;
    dialog.classList.remove('is-in');
    closing = window.setTimeout(() => dialog.close(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
  };
  const onClosed = () => {
    dialog.classList.remove('is-in');
    scroll.unlock('panel');
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  };
  const onCancel = (e: Event) => { e.preventDefault(); shut(); }; // Escape: slide out first, then close
  const onClick = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t === dialog) return shut(); // a click on the dimmed backdrop
    const hit = t.closest<HTMLElement>(OPENERS);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation(); // capture phase: Lenis' own anchor handler never sees it (it would scroll the page, not the panel)
    const href = hit instanceof HTMLAnchorElement ? hit.getAttribute('href') : null;
    const id = href ? href.slice(1) : undefined;
    if (dialog.contains(hit)) { if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } // the index rail
    else open(id);
  };
  const fromHash = (atLoad = false) => {
    const h = location.hash.slice(1);
    if (h !== 'reference' && !h.startsWith('ref-')) return;
    if (atLoad) window.scrollTo(0, 0); // the browser jumped to where the section used to sit in the page: the story stays at the start behind the panel
    open(h);
  };

  close.addEventListener('click', shut);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClosed);
  document.addEventListener('click', onClick, true);
  const onHash = () => fromHash();
  window.addEventListener('hashchange', onHash);
  fromHash(true);

  return () => {
    clearTimeout(closing);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('hashchange', onHash);
    dialog.removeEventListener('close', onClosed);
    if (dialog.open) { dialog.close(); scroll.unlock('panel'); }
    refHome[0].insertBefore(ref, refHome[1]);
    if (footer && footerHome) footerHome[0].insertBefore(footer, footerHome[1]);
    dialog.remove();
    document.querySelectorAll('[aria-haspopup="dialog"]').forEach((el) => el.removeAttribute('aria-haspopup'));
  };
}
