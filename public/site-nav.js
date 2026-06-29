(function initSiteNav() {
  const computeProjectBasePath = () => {
    if (!/github\.io$/i.test(window.location.hostname)) {
      return "";
    }

    const parts = String(window.location.pathname || "")
      .split("/")
      .filter(Boolean);

    if (!parts.length) {
      return "";
    }

    const firstPart = parts[0];
    if (firstPart.includes(".")) {
      return "";
    }

    return `/${firstPart}`;
  };

  const projectBasePath = computeProjectBasePath();

  const withProjectBasePath = (href) => {
    if (!projectBasePath) {
      return href;
    }

    const normalizedHref = String(href || "");
    if (!normalizedHref.startsWith("/") || normalizedHref.startsWith("//")) {
      return normalizedHref;
    }

    if (
      normalizedHref === projectBasePath ||
      normalizedHref.startsWith(`${projectBasePath}/`)
    ) {
      return normalizedHref;
    }

    return `${projectBasePath}${normalizedHref}`;
  };

  const rewriteNavLinksForProjectPages = () => {
    if (!projectBasePath) {
      return;
    }

    document.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href) {
        return;
      }
      const rewritten = withProjectBasePath(href);
      if (rewritten !== href) {
        anchor.setAttribute("href", rewritten);
      }
    });
  };

  rewriteNavLinksForProjectPages();

  const navToggleBtn = document.getElementById("navToggleBtn");
  const siteNavDrawer = document.getElementById("siteNavDrawer");
  const profileMenus = Array.from(document.querySelectorAll(".site-nav-profile"));

  const closeDrawer = () => {
    siteNavDrawer?.classList.remove("open");
  };

  const closeProfileMenus = (exceptMenu = null) => {
    profileMenus.forEach((menu) => {
      if (menu !== exceptMenu) {
        menu.open = false;
      }
    });
  };

  if (navToggleBtn && siteNavDrawer) {
    navToggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeProfileMenus();
      siteNavDrawer.classList.toggle("open");
    });

    siteNavDrawer.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        closeDrawer();
      });
    });
  }

  profileMenus.forEach((menu) => {
    const summary = menu.querySelector("summary");
    if (summary) {
      summary.addEventListener("click", () => {
        if (!menu.open) {
          closeProfileMenus(menu);
          closeDrawer();
        }
      });
    }

    menu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        menu.open = false;
        closeDrawer();
      });
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;

    if (siteNavDrawer && navToggleBtn) {
      const clickedDrawer = siteNavDrawer.contains(target);
      const clickedToggle = navToggleBtn.contains(target);
      if (!clickedDrawer && !clickedToggle) {
        closeDrawer();
      }
    }

    profileMenus.forEach((menu) => {
      if (!menu.contains(target)) {
        menu.open = false;
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      closeProfileMenus();
    }
  });
})();