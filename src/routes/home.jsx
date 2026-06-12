import Head from "../components/head";
import Tabs from "../components/tabs";
import Windows from "../components/windows";
import ArrowRight from "../icons/arrow-right";
import ArrowLeft from "../icons/arrow-left";
import RotateCW from "../icons/rotate-cw";
import ViewSidebar from "../icons/view-sidebar";
import SettingsIcon from "../icons/settings";
import Fullscreen from "../icons/fullscreen";
import { searchURL } from "../util/searchURL";
import Settings from "../components/settings";

const Home = function () {
    const loadFavorites = () => {
        try {
            const raw = localStorage.getItem("@nano/favorites");
            const parsed = raw ? JSON.parse(raw) : [];

            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed.filter(
                (favorite) =>
                    favorite &&
                    typeof favorite.url === "string" &&
                    favorite.url,
            );
        } catch {
            return [];
        }
    };

    const isAgeConfirmed = () =>
        localStorage.getItem("@nano/ageConfirmed") === "true";

    this.theme = localStorage.getItem("@nano/theme") || "mocha";
    this.windows = null;
    this.search = null;
    this.sidebar = localStorage.getItem("@nano/sidebar") !== "false";
    this.sidebarPage = localStorage.getItem("@nano/sidebarPage") || "tabs";
    this.tabsActive = false;
    this.settingsActive = false;
    this.tabs = [{ title: "New Tab" }];
    this.current = 0;
    this.currentHasURL = false;
    this.searchEngine =
        localStorage.getItem("@nano/searchEngine") ||
        "https://duckduckgo.com/?q=%s&ia=web";
    this.favorites = loadFavorites();
    this.ageConfirmed = isAgeConfirmed();
    this.ageCheck = false;
    this.agePromptError = false;

    const searchEngineLabels = {
        "https://www.google.com/search?q=%s": "Google",
        "https://duckduckgo.com/?q=%s&ia=web": "DuckDuckGo",
        "https://www.bing.com/search?q=%s": "Bing",
        "https://search.yahoo.com/search?p=%s": "Yahoo",
        "https://search.brave.com/search?q=%s": "Brave",
        "https://searx.si/search?q=%s": "SearXNG",
    };

    useChange(this.searchEngine, () => {
        localStorage.setItem("@nano/searchEngine", this.searchEngine);
    });

    useChange(this.favorites, () => {
        localStorage.setItem("@nano/favorites", JSON.stringify(this.favorites));
    });

    useChange(this.ageConfirmed, () => {
        if (this.ageConfirmed) {
            localStorage.setItem("@nano/ageConfirmed", "true");
            this.agePromptError = false;
            return;
        }

        localStorage.removeItem("@nano/ageConfirmed");
    });

    useChange([this.sidebar, this.sidebarPage], () => {
        this.tabsActive = this.sidebar && this.sidebarPage == "tabs";
        this.settingsActive = this.sidebar && this.sidebarPage == "settings";
    });

    useChange(this.sidebarPage, () => {
        localStorage.setItem("@nano/sidebarPage", this.sidebarPage);
    });

    useChange(this.sidebar, () => {
        localStorage.setItem("@nano/sidebar", String(this.sidebar));
    });

    useChange([this.search, this.current], () => {
        if (this.search) {
            this.search.value = this.tabs[this.current].url || "";
        }
    });

    useChange(this.current, () => {
        this.currentHasURL = this.tabs[this.current].hasOwnProperty("url");
    });

    const createIFrame = async (tab) => {
        const newIFrame = document.createElement("iframe");
        newIFrame.src = await searchURL(tab.url, this.searchEngine);
        newIFrame.classList = "window";
        newIFrame.dataset.current = "true";
        newIFrame.addEventListener("load", (e) => {
            addKeybinds(e.target.contentWindow);
            interceptLinks(e.target.contentWindow);

            tab.url = window.__uv$config.decodeUrl(
                e.target.contentWindow.location.pathname.split(
                    window.__uv$config.prefix,
                )[1],
            );
            if (this.search) {
                this.search.value = this.tabs[this.current].url || "";
            }

            let newTitle = e.target.contentWindow.document.title;
            if (newTitle !== tab.title) {
                tab.title = newTitle || tab.url;
                updateTitles();
            }
        });
        this.windows.appendChild(newIFrame);

        return newIFrame;
    };

    const searchKeydown = async (e) => {
        if (e.key == "Enter" && e.target.value) {
            this.tabs[this.current].url = e.target.value;

            if (this.tabs[this.current].hasOwnProperty("iframe")) {
                this.tabs[this.current].iframe.src = await searchURL(
                    this.tabs[this.current].url,
                    this.searchEngine,
                );
            } else {
                this.tabs[this.current].iframe = await createIFrame(
                    this.tabs[this.current],
                );
                this.currentHasURL = true;
            }
        }
    };

    const back = () => {
        const currentTab = this.tabs[this.current];
        if (currentTab?.iframe?.contentWindow) {
            if (
                !currentTab.iframe.contentWindow.navigation ||
                currentTab.iframe.contentWindow.navigation.canGoBack
            ) {
                currentTab.iframe.contentWindow.history.back();
            }
        }
    };

    const goToPreviousPage = () => {
        if (window.history.length > 1) {
            window.history.back();
            return;
        }

        window.location.href = "/";
    };

    const forward = () => {
        const currentTab = this.tabs[this.current];
        if (currentTab?.iframe?.contentWindow) {
            currentTab.iframe.contentWindow.history.forward();
        }
    };

    const reload = () => {
        const currentTab = this.tabs[this.current];
        if (currentTab?.iframe?.contentWindow) {
            try {
                currentTab.iframe.contentWindow.location.reload();
            } catch {
                currentTab.iframe.src += "";
            }
        }
    };

    const toggleFullscreen = async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }

            await this.windows?.requestFullscreen?.();
        } catch {}
    };

    const confirmAge = () => {
        if (!this.ageCheck) {
            this.agePromptError = true;
            return;
        }

        this.ageConfirmed = true;
    };

    const leaveSite = () => {
        window.location.href = "/";
    };

    const updateTitles = () => {
        for (let tab of [...document.querySelectorAll(".proxy-tab")]) {
            tab.dispatchEvent(new Event("nanoUpdateTitle"));
        }
    };

    setInterval(() => {
        if (this.tabs[this.current].hasOwnProperty("iframe")) {
            let newLocation =
                this.tabs[this.current].iframe.contentWindow.location;
            if (!newLocation.href.startsWith("about:")) {
                let decodedLocation = window.__uv$config.decodeUrl(
                    newLocation.pathname.split(window.__uv$config.prefix)[1],
                );

                if (decodedLocation !== this.tabs[this.current].url) {
                    this.tabs[this.current].url = decodedLocation;
                    this.search.value = decodedLocation;
                }

                let newTitle =
                    this.tabs[this.current].iframe.contentWindow.document.title;
                if (newTitle !== this.tabs[this.current].title) {
                    this.tabs[this.current].title =
                        newTitle || this.tabs[this.current].url;
                    updateTitles();
                }
            }
        }
    }, 1000);

    const toggleSidebar = (page) => {
        if (this.sidebarPage !== page) {
            if (!this.sidebar) {
                this.sidebar = true;
            }
            this.sidebarPage = page;
        } else {
            this.sidebar = !this.sidebar;
        }
    };

    const newTab = async (title = "New Tab", url) => {
        for (let tab of this.tabs) {
            if (tab.hasOwnProperty("iframe")) {
                tab.iframe.dataset.current = "false";
            }
        }

        let createdTab = { title };
        if (url) createdTab.url = url;

        this.tabs = [createdTab, ...this.tabs];
        this.current = 0;
        this.tabs = [...this.tabs];

        if (url) {
            createdTab.iframe = await createIFrame(this.tabs[this.current]);
        }
    };

    const saveCurrentFavorite = () => {
        const currentTab = this.tabs[this.current];
        if (!currentTab?.url) {
            return;
        }

        const nextFavorite = {
            title: currentTab.title || currentTab.url,
            url: currentTab.url,
        };
        const existingIndex = this.favorites.findIndex(
            (favorite) => favorite.url === nextFavorite.url,
        );

        if (existingIndex >= 0) {
            this.favorites = this.favorites.map((favorite, index) =>
                index === existingIndex ? nextFavorite : favorite,
            );
            return;
        }

        this.favorites = [nextFavorite, ...this.favorites];
    };

    const removeFavorite = (url) => {
        this.favorites = this.favorites.filter(
            (favorite) => favorite.url !== url,
        );
    };

    const removeTab = (index) => {
        for (let tab of this.tabs) {
            if (tab.hasOwnProperty("iframe")) {
                tab.iframe.dataset.current = "false";
            }
        }

        if (this.tabs[index].iframe) {
            this.tabs[index].iframe.remove();
        }
        if (index == this.current) {
            if (index > 0) {
                this.current--;
            }
        } else if (index < this.current) {
            this.current--;
        }
        this.tabs = this.tabs.filter((_tab, i) => i !== index);
        if (this.tabs[this.current]?.iframe) {
            this.tabs[this.current].iframe.dataset.current = "true";
        }
        this.tabs = [...this.tabs];
        setTimeout(() => {
            if (!this.tabs.length) {
                newTab();
            }
        });
    };

    const interceptLinks = (win = window) => {
        win.open = new Proxy(win.open, {
            apply(_target, _thisArg, argArray) {
                if (argArray[0]) {
                    newTab(argArray[0], argArray[0]);
                }
                return;
            },
        });

        win.addEventListener("click", (e) => {
            if (e.target.tagName == "A" && e.target.hasAttribute("href")) {
                let isNewTab =
                    e.ctrlKey ||
                    e.shiftKey ||
                    (e.target.hasAttribute("target") &&
                        e.target.getAttribute("target").includes("_blank"));

                if (isNewTab) {
                    e.preventDefault();
                    newTab(
                        e.target.getAttribute("href"),
                        e.target.getAttribute("href"),
                    );
                }
            }
        });
    };

    const addKeybinds = (win = window) => {
        win.addEventListener("keyup", (e) => {
            if (!this.ageConfirmed) {
                return;
            }

            if (e.altKey && !e.ctrlKey && !e.shiftKey) {
                switch (e.key) {
                    case "a":
                        toggleSidebar("tabs");
                        break;
                    case "s":
                        toggleSidebar("settings");
                        break;
                    case "t":
                        newTab();
                        break;
                    case "w":
                        removeTab(this.current);
                        break;
                    case "r":
                        reload();
                        break;
                    case "n":
                        this.search.select();
                        this.search.focus();
                        break;
                    case "ArrowLeft":
                        back();
                        break;
                    case "ArrowRight":
                        forward();
                        break;
                }
            }
        });
    };

    addKeybinds();

    return (
        <div class="proxy-app">
            <Head bind:theme={use(this.theme)} />
            {$if(
                use(this.ageConfirmed, (ageConfirmed) => !ageConfirmed),
                <div class="proxy-age-gate">
                    <div class="proxy-age-card proxy-panel">
                        <p class="proxy-age-eyebrow">Age Confirmation Required</p>
                        <h1>Before you continue</h1>
                        <p class="proxy-age-copy">
                            You must be at least 13 years old to use this site.
                            Confirm that you are 13 or older to continue.
                        </p>
                        <label class="proxy-age-check">
                            <input
                                type="checkbox"
                                checked={use(this.ageCheck)}
                                on:change={(e) => {
                                    this.ageCheck = e.target.checked;
                                    if (this.ageCheck) {
                                        this.agePromptError = false;
                                    }
                                }}
                            />
                            <span>I confirm that I am 13 years old or older.</span>
                        </label>
                        {$if(
                            use(this.agePromptError),
                            <p class="proxy-age-error">
                                Confirm your age before entering the site.
                            </p>,
                        )}
                        <div class="proxy-age-actions">
                            <button
                                type="button"
                                class="proxy-settings-btn proxy-age-primary"
                                on:click={confirmAge}
                            >
                                Continue
                            </button>
                            <button
                                type="button"
                                class="proxy-settings-btn"
                                on:click={leaveSite}
                            >
                                Leave site
                            </button>
                        </div>
                    </div>
                </div>,
            )}
            <div class="proxy-shell">
                <div class="proxy-ambient proxy-ambient-a"></div>
                <div class="proxy-ambient proxy-ambient-b"></div>
                <div class="proxy-noise"></div>
                <div
                    class="proxy-sidebar-slot"
                    class:sidebar-open={use(this.sidebar)}
                >
                    <button
                        type="button"
                        class="proxy-mobile-backdrop"
                        aria-label="Close sidebar"
                        on:click={() => (this.sidebar = false)}
                    ></button>
                    <Tabs
                        bind:current={use(this.current)}
                        bind:iframes={use(this.windows)}
                        bind:tabs={use(this.tabs)}
                        bind:tabsActive={use(this.tabsActive)}
                        bind:currentHasURL={use(this.currentHasURL)}
                        bind:searchEngine={use(this.searchEngine)}
                        bind:favorites={use(this.favorites)}
                        bind:sidebar={use(this.sidebar)}
                        newTab={newTab}
                        openFavorite={newTab}
                        saveCurrentFavorite={saveCurrentFavorite}
                        removeFavorite={removeFavorite}
                        removeTab={removeTab}
                    />
                    <Settings
                        bind:settingsActive={use(this.settingsActive)}
                        bind:theme={use(this.theme)}
                        bind:searchEngine={use(this.searchEngine)}
                    />
                </div>
                <Windows
                    bind:windows={use(this.windows)}
                    bind:current={use(this.current)}
                    bind:search={use(this.search)}
                    bind:currentHasURL={use(this.currentHasURL)}
                    bind:tabs={use(this.tabs)}
                    bind:sidebar={use(this.sidebar)}
                    bind:searchEngine={use(this.searchEngine)}
                    createIFrame={createIFrame}
                    newTab={newTab}
                />

                <div
                    class="proxy-command proxy-panel"
                    class:command-full={use(this.sidebar, (sidebar) => !sidebar)}
                >
                    <div class="proxy-command-left">
                        <button
                            on:click={goToPreviousPage}
                            aria-label="Back to previous page"
                            title="Back to previous page"
                            class="proxy-command-btn"
                        >
                            <ArrowLeft />
                        </button>
                        <button
                            on:click={() => toggleSidebar("tabs")}
                            aria-label="Tabs Sidebar"
                            title="Tabs (Alt+A)"
                            class="proxy-command-btn"
                            class:active={use(this.tabsActive)}
                        >
                            <ViewSidebar />
                        </button>
                        <button
                            on:click={() => toggleSidebar("settings")}
                            aria-label="Settings Sidebar"
                            title="Settings (Alt+S)"
                            class="proxy-command-btn"
                            class:active={use(this.settingsActive)}
                        >
                            <SettingsIcon />
                        </button>
                        <span class="proxy-command-summary">
                            {use(this.tabs, (tabs) =>
                                `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`,
                            )}
                        </span>
                        <span class="proxy-command-summary proxy-command-summary-muted">
                            {use(
                                this.searchEngine,
                                (searchEngine) =>
                                    searchEngineLabels[searchEngine] ||
                                    "Custom",
                            )}
                        </span>
                    </div>
                    <div class="proxy-input-wrap">
                        <input
                            autofocus
                            bind:this={use(this.search)}
                            on:keydown={searchKeydown}
                            placeholder="Search or type a URL"
                            class="proxy-input"
                            autocapitalize="off"
                            autocomplete="off"
                            autocorrect="off"
                            spellcheck="false"
                            inputmode="url"
                        />
                    </div>
                    <div class="proxy-nav-cluster">
                        <button
                            on:click={back}
                            aria-label="Back"
                            title="Go Back (Alt+Left)"
                            class="proxy-command-btn"
                        >
                            <ArrowLeft />
                        </button>
                        <button
                            on:click={forward}
                            aria-label="Forward"
                            title="Go Forward (Alt+Right)"
                            class="proxy-command-btn"
                        >
                            <ArrowRight />
                        </button>
                        <button
                            on:click={reload}
                            aria-label="Reload"
                            title="Reload (Alt+R)"
                            class="proxy-command-btn"
                        >
                            <RotateCW />
                        </button>
                        <button
                            on:click={toggleFullscreen}
                            aria-label="Fullscreen"
                            title="Toggle Fullscreen"
                            class="proxy-command-btn"
                        >
                            <Fullscreen />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Home;
