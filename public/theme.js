// Loaded in <head>, before the stylesheet. Applies the saved theme before the page paints so it never flashes the wrong colours.
try {
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.querySelector('meta[name="theme-color"]').content = '#ebe7df';
  }
} catch {}
