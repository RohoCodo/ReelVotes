(function initSiteNav() {
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