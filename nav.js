(() => {
  const mobileQuery = window.matchMedia('(max-width: 768px)');
  const taskbars = document.querySelectorAll('.taskbar');
  let lastScrollY = window.scrollY || 0;

  taskbars.forEach((taskbar, index) => {
    const taskLinks = taskbar.querySelector('.task-links');
    if (!taskLinks) return;

    if (!taskLinks.id) {
      taskLinks.id = `task-links-${index + 1}`;
    }

    const menuButton = document.createElement('button');
    menuButton.className = 'taskbar-menu-toggle';
    menuButton.type = 'button';
    menuButton.setAttribute('aria-controls', taskLinks.id);
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Toggle navigation menu');
    menuButton.innerHTML = '<span class="burger-icon" aria-hidden="true"></span>';
    taskbar.insertBefore(menuButton, taskLinks);
    menuButton.hidden = true;
    menuButton.style.display = 'none';

    const navDropdowns = [...taskLinks.querySelectorAll('.nav-dropdown')];

    const closeDropdowns = () => {
      navDropdowns.forEach((dd) => dd.classList.remove('open'));
    };

    const closeMenu = () => {
      taskbar.classList.remove('menu-open');
      menuButton.setAttribute('aria-expanded', 'false');
      closeDropdowns();
    };

    const toggleMenu = () => {
      if (!mobileQuery.matches) return;
      const isOpen = taskbar.classList.toggle('menu-open');
      menuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (!isOpen) closeDropdowns();
    };

    const syncViewportState = () => {
      if (mobileQuery.matches) {
        menuButton.hidden = false;
        menuButton.style.display = 'inline-flex';
      } else {
        closeMenu();
        taskbar.classList.remove('taskbar-hidden-mobile');
        lastScrollY = window.scrollY || 0;
        menuButton.hidden = true;
        menuButton.style.display = 'none';
      }
    };

    menuButton.addEventListener('click', toggleMenu);

    navDropdowns.forEach((dropdown) => {
      const toggle = dropdown.querySelector('.nav-dropdown-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', (event) => {
        if (!mobileQuery.matches) return;
        if (!taskbar.classList.contains('menu-open')) return;
        const alreadyOpen = dropdown.classList.contains('open');
        if (!alreadyOpen) {
          event.preventDefault();
          closeDropdowns();
          dropdown.classList.add('open');
          return;
        }
        closeDropdowns();
      });
    });

    taskLinks.addEventListener('click', (event) => {
      const clickedLink = event.target.closest('a');
      if (!clickedLink || !mobileQuery.matches) return;
      if (clickedLink.classList.contains('nav-dropdown-toggle')) return;
      closeMenu();
    });

    document.addEventListener('click', (event) => {
      if (!mobileQuery.matches || !taskbar.classList.contains('menu-open')) return;
      if (taskbar.contains(event.target)) return;
      closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    });

    mobileQuery.addEventListener('change', syncViewportState);
    syncViewportState();

    window.addEventListener(
      'scroll',
      () => {
        if (!mobileQuery.matches) return;
        if (taskbar.classList.contains('menu-open')) {
          taskbar.classList.remove('taskbar-hidden-mobile');
          lastScrollY = window.scrollY || 0;
          return;
        }
        const currentY = window.scrollY || 0;
        const delta = currentY - lastScrollY;
        const nearTop = currentY <= 8;
        if (nearTop || delta < -2) {
          taskbar.classList.remove('taskbar-hidden-mobile');
        } else if (delta > 2) {
          taskbar.classList.add('taskbar-hidden-mobile');
        }
        lastScrollY = currentY;
      },
      { passive: true }
    );
  });
})();
