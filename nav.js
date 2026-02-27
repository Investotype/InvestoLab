(() => {
  const mobileQuery = window.matchMedia('(max-width: 768px)');
  const taskbars = document.querySelectorAll('.taskbar');

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
    menuButton.innerHTML = '<span class="burger-icon" aria-hidden="true"></span><span>Menu</span>';
    taskbar.insertBefore(menuButton, taskLinks);

    const primaryLinks = document.createElement('div');
    primaryLinks.className = 'mobile-primary-links';
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';
    const pages = [
      { href: './index.html', label: 'Overview', match: ['index.html', ''] },
      { href: './valuation-lab.html', label: 'Valuation Lab', match: ['valuation-lab.html', 'valuation.html', 'portfolio-builder.html', 'portfolio-result.html'] },
      { href: './investotype.html', label: 'InvestoType', match: ['investotype.html', 'simulator.html', 'quiz.html', 'investor-types.html'] },
      { href: './news.html', label: 'News', match: ['news.html', 'news-market.html', 'news-tailored.html', 'news-investment-day.html', 'news-investment-week.html', 'news-investment-month.html', 'news-investment-year.html'] },
      { href: './about.html', label: 'About', match: ['about.html'] }
    ];

    primaryLinks.innerHTML = pages.map((page) => {
      const activeClass = page.match.includes(currentPath) ? ' class="active"' : '';
      const currentAttr = page.match.includes(currentPath) ? ' aria-current="page"' : '';
      return `<a href="${page.href}"${activeClass}${currentAttr}>${page.label}</a>`;
    }).join('');
    taskLinks.prepend(primaryLinks);

    const closeMenu = () => {
      taskbar.classList.remove('menu-open');
      menuButton.setAttribute('aria-expanded', 'false');
    };

    const toggleMenu = () => {
      const isOpen = taskbar.classList.toggle('menu-open');
      menuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    menuButton.addEventListener('click', toggleMenu);

    taskLinks.addEventListener('click', (event) => {
      const clickedLink = event.target.closest('a');
      if (!clickedLink || !mobileQuery.matches) return;
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

    mobileQuery.addEventListener('change', (event) => {
      if (!event.matches) {
        closeMenu();
      }
    });
  });
})();
