// The last time a refresh of the page was done
let lastRefresh = (new Date()).getTime();
let jiraLogo = chrome.runtime.getURL("images/jira.png");
let jiraUrl = '';
let acceptanceStartString = 'h3. Acceptance Criteria';
let acceptanceEndString  = 'h3. Notes';
let prTemplate = `
    ### Fix {{TICKETNUMBER}}
    Link to ticket: {{TICKETURL}}

    ### What has been done
    -
    -

    ### How to test
    -
    -

    ### Acceptance criteria
    {{ACCEPTANCE}}

    ### Todo
    - [ ]
    - [ ]

    ### Notes
    -
    -
`;
let prTemplateEnabled = true;
let prTitleEnabled = true;

const REFRESH_TIMEOUT = 250;

main().catch(err => console.error('Unexpected error', err))

/////////////////////////////////
// CONSTANTS
/////////////////////////////////

const PAGE_PR = 'PAGE_PR';
const PAGE_PR_CREATE = 'PAGE_PR_CREATE';

const GITHUB_PAGE_PULL = /github\.com\/(.*)\/(.*)\/pull\//
const GITHUB_PAGE_PULLS = /github\.com\/(.*)\/(.*)\/pulls/
const GITHUB_PAGE_COMPARE = /github\.com\/(.*)\/(.*)\/compare\/(.*)/

/////////////////////////////////
// TEMPLATES
/////////////////////////////////

function commitStreamEl(href, content) {
    const el = document.createElement('div');
    el.innerHTML = `
        <a href="${href}">${content[0]}</a>
        <a href="${getJiraUrl(content[1])}" target="_blank" alt="Ticket in Jira"><b>${content[1]}</b></a>
        <a href="${href}">${content[2].trim()}</a>
    `;
    return el;
}

function titleHTMLContent(title, issueKey) {
    return title.replace(/([A-Z0-9]+-[0-9]+)/, `
        <a href="${getJiraUrl(issueKey)}" target="_blank" alt="Ticket in Jira">${issueKey}</a>
    `);
}


function userHTMLContent(text, user) {
    if (user && typeof user === 'object') {
        const { avatarUrls, displayName } = user
        return `
            <div class="d-inline-block">
                ${text}
                <span class="author text-bold">
                    <a class="no-underline"><img style="float:none;margin-right:0" class="avatar avatar-user" src="${avatarUrls['16x16']}" width="20"/></a>
                    ${displayName}
                </span>
            </div>
        `
    }
    return ''
}

function buildLoadingElement(issueKey) {
    const el = document.createElement('div');
    el.id = 'insertedJiraData';
    el.className = 'gh-header-meta';
    el.innerText = `Loading ticket ${issueKey}...`;
    return el;
}

function statusIconBlock(statusIcon) {
    if (!statusIcon) {
        return ''
    }

    const origin = new URL(statusIcon).origin
    const base = new URL(origin).href

    // If the icon is the same as its origin, it most probably is not an image
    if (statusIcon === origin || statusIcon === base) {
        return ''
    }

    return `<img height="16" class="octicon" width="12" aria-hidden="true" src="${statusIcon}"/>`
}

function statusCategoryColors(statusCategory) {
    // There are only "blue", "green", and "grey" in Jira
    switch (statusCategory.colorName) {
        case "blue":
            return { color: "white", background: "rgb(150, 198, 222)" }
        case "green":
            return { color: "white", background: "#28a745" }
        default:
            return { color: "rgb(40, 40, 40)", background: "rgb(220, 220, 220)" }
    }
}

function headerBlock(issueKey,
    {
        assignee,
        reporter,
        status: { iconUrl: statusIcon, name: statusName, statusCategory } = {},
        summary
    } = {}
) {
    const issueUrl = getJiraUrl(issueKey)
    const statusIconHTML = statusIconBlock(statusIcon)
    const { color: statusColor, background: statusBackground } = statusCategoryColors(statusCategory);
    return `
        <div class="TableObject">
            <div class="TableObject-item">
                <span class="State State--green" style="background-color: rgb(150, 198, 222);">
                    <img height="16" class="octicon" width="12" aria-hidden="true" src="${jiraLogo}"/>
                    <a style="color:white;" href="${issueUrl}" target="_blank">Jira</a>
                </span>
            </div>
            <div class="TableObject-item">
                <span class="State State--white" style="color: ${statusColor}; background: ${statusBackground}">
                    ${statusIconHTML}
                    ${statusName}
                </span>
            </div>
            <div class="TableObject-item TableObject-item--primary">
                <strong>
                    <a href="${issueUrl}" target="_blank">
                        ${issueKey} - ${summary}
                    </a>
                </strong>
                <div class="d-inline-block">
                    ${userHTMLContent('Reported by', reporter)}
                    ${userHTMLContent('and assigned to', assignee)}
                </div>
            </div>
        </div>
    `
}

/////////////////////////////////
// FUNCTIONS
/////////////////////////////////

async function main(items) {
    (
        {
            jiraUrl,
            acceptanceStartString,
            acceptanceEndString,
            prTemplateEnabled,
            prTitleEnabled,
            prTemplate
        } = await syncStorage({
            jiraUrl,
            acceptanceStartString,
            acceptanceEndString,
            prTemplateEnabled,
            prTitleEnabled,
            prTemplate
        })
    );

    if (jiraUrl == '') {
        console.error('GitHub Jira plugin could not load: Jira URL is not set. Please set the correct Jira URL in the options page.');
        return;
    }

    try {
        // Checks the login
        const { name } = await sendMessage({ query: 'getSession', jiraUrl });

        // Hook into the turbo render event, for subsequent navigation
        document.addEventListener('turbo:render', checkPage, { passive: true });

        // Check page initially (on first load)
        checkPage();
    } catch(e) {
        console.error(`You are not logged in to Jira at ${jiraUrl} - Please login.`);
        console.error(e);
    }
}


function getJiraUrl(route = '') {
    return `https://${jiraUrl}/browse/${route}`
}

/**
 * Génère une couleur basée sur le hash du nom du label
 * pour assurer une couleur cohérente et unique par label
 */
function getLabelColor(labelName) {
    // Couleurs personnalisées pour certains labels spécifiques (optionnel)
    const customColors = {
        'Backend': '#0e8a16',
        'Frontend': '#a2eeef',
        'Sentry': '#b60205',
    };

    // Si une couleur personnalisée existe, l'utiliser
    if (customColors[labelName]) {
        return customColors[labelName];
    }

    // Sinon, générer une couleur basée sur le hash du nom
    let hash = 0;
    for (let i = 0; i < labelName.length; i++) {
        hash = labelName.charCodeAt(i) + ((hash << 5) - hash);
        hash = hash & hash; // Convert to 32bit integer
    }

    // Générer une couleur HSL avec une saturation et luminosité agréables
    const hue = Math.abs(hash % 360);
    const saturation = 65 + (Math.abs(hash) % 20); // 65-85%
    const lightness = 40 + (Math.abs(hash >> 8) % 15); // 40-55%

    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Obtient la couleur pour un type de ticket Jira
 */
function getIssueTypeColor(issueTypeName) {
    const typeColors = {
        'Bug': '#d73a4a',
        'Task': '#0075ca',
        'Story': '#0e8a16',
        'Epic': '#5319e7',
        'Sub-task': '#fbca04',
        'Tech': '#1d76db',
        'Improvement': '#2ea44f',
        'Feature': '#2ea44f',
    };

    return typeColors[issueTypeName] || '#6a737d';
}

/**
 * Crée un élément label pour affichage
 */
function createLabelElement(labelText, ticketNumber, isIssueType = false) {
    const labelEl = document.createElement('span');
    const bgColor = isIssueType ? getIssueTypeColor(labelText) : getLabelColor(labelText);
    const textColor = getContrastColor(bgColor);

    labelEl.className = 'IssueLabel hx_IssueLabel';
    labelEl.style.backgroundColor = bgColor;
    labelEl.style.color = textColor;
    labelEl.style.borderRadius = '2em';
    labelEl.style.padding = '0 7px';
    labelEl.style.fontSize = '12px';
    labelEl.style.fontWeight = '500';
    labelEl.style.lineHeight = '18px';
    labelEl.style.display = 'inline-block';
    labelEl.style.whiteSpace = 'nowrap';
    labelEl.style.cursor = 'pointer';
    labelEl.title = isIssueType ? `Jira type: ${labelText}` : `Jira label: ${labelText}`;
    labelEl.innerHTML = `<img src="${jiraLogo}" alt="Jira" style="width: 12px; height: 12px; vertical-align: middle; margin-right: 2px;"/> ${labelText}`;

    // Rendre le label cliquable
    labelEl.onclick = () => {
        window.open(getJiraUrl(ticketNumber), '_blank');
    };

    return labelEl;
}

/**
 * Calcule la luminosité d'une couleur pour déterminer si le texte doit être blanc ou noir
 */
function getContrastColor(color) {
    // Si c'est une couleur HSL
    if (color.startsWith('hsl')) {
        const matches = color.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
        if (matches) {
            const lightness = parseInt(matches[3]);
            return lightness > 60 ? '#000000' : '#ffffff';
        }
    }

    // Si c'est une couleur hex
    if (color.startsWith('#')) {
        const hex = color.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    return '#ffffff'; // Par défaut, texte blanc
}

async function syncStorage(data) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(data, resolve);
    })
}

async function sendMessage(data) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(data, resolve);
    })
}


function onPageChange(page) {
    setTimeout(function() {
        handleCommitsTitle();
        if (page === PAGE_PR) handlePrPage();
        if (page === PAGE_PR_CREATE) handlePrCreatePage();
    }, 200); //Small timeout for dom to finish setup
}

function checkPage() {
    let url = window.location.href;
    console.log(url);
    if (url.match(GITHUB_PAGE_PULL) != null) {
        onPageChange(PAGE_PR)
    }

    if (url.match(GITHUB_PAGE_PULLS) != null) {
        handlePrsPage()
    }

    if (url.match(GITHUB_PAGE_COMPARE) != null) {
        onPageChange(PAGE_PR_CREATE);
    }
}


function handleCommitsTitle() {
    document.querySelectorAll('.commit-message code').forEach((el) => {
        const linkEl = el.querySelector('a');
        const linkHtml = linkEl.innerHTML;
        const splittedContent = linkHtml.split(/([A-Z]+-[0-9]+)/g);

        if (splittedContent.length < 3) {
            return;
        }

        const contentEl = document.createElement('div');
        for(var i=0; i< splittedContent.length; i+=3) {
            contentEl.appendChild(commitStreamEl(linkEl.getAttribute('href'), splittedContent));
        }
        el.innerHTML = '';
        el.appendChild(contentEl);
    });
}

async function handlePrsPage() {
    // Sélectionner toutes les lignes de PR qui n'ont pas encore été traitées
    const prRows = document.querySelectorAll('div.js-issue-row:not([data-jira-processed])');

    console.log("handlePrsPage");
    console.log(prRows);
    for (const row of prRows) {
        // Vérifier d'abord si les labels Jira existent déjà (double protection)
        if (row.querySelector('.jira-labels-inline')) {
            row.setAttribute('data-jira-processed', 'true');
            continue;
        }

        // Trouver le titre de la PR
        const titleLink = row.querySelector('a.Link--primary');
        if (!titleLink) {
            continue;
        }

        const title = titleLink.innerText;

        // Extraire le numéro de ticket Jira du titre
        const ticketMatch = title.match(/([A-Z0-9]+-[0-9]+)/);
        if (!ticketMatch) {
            // Marquer comme traité même sans ticket Jira
            row.setAttribute('data-jira-processed', 'true');
            continue;
        }

        const ticketNumber = ticketMatch[0];

        // Marquer comme traité IMMÉDIATEMENT pour éviter les traitements parallèles
        row.setAttribute('data-jira-processed', 'true');

        try {
            // Récupérer les informations du ticket depuis Jira
            const result = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber });
            if (result.errors) {
                console.error('Error fetching ticket info:', result.errorMessages);
                continue;
            }

            const { fields } = result;

            // Chercher le conteneur du titre pour y insérer les labels juste après
            const titleContainer = titleLink.parentElement;
            if (!titleContainer) {
                continue;
            }

            // Double vérification : si les labels ont déjà été ajoutés par un appel parallèle, on arrête
            if (titleContainer.querySelector('.jira-labels-inline')) {
                console.log('Labels already added for', ticketNumber);
                continue;
            }

            // Créer un conteneur pour les labels Jira
            const jiraLabelsContainer = document.createElement('span');
            jiraLabelsContainer.className = 'jira-labels-inline';
            jiraLabelsContainer.style.marginLeft = '8px';
            jiraLabelsContainer.style.display = 'inline-flex';
            jiraLabelsContainer.style.gap = '4px';
            jiraLabelsContainer.style.flexWrap = 'wrap';
            jiraLabelsContainer.style.alignItems = 'center';

            // Ajouter le type de ticket en premier
            if (fields?.issuetype?.name) {
                const issueTypeLabel = createLabelElement(fields.issuetype.name, ticketNumber, true);
                jiraLabelsContainer.appendChild(issueTypeLabel);
            }

            // Filtrer les labels pour exclure "Symfony" et "Nuxt"
            const excludedLabels = ['Symfony', 'Nuxt'];
            const filteredLabels = fields.labels?.filter(label => !excludedLabels.includes(label)) || [];

            // Ajouter chaque label
            filteredLabels.forEach(label => {
                const labelEl = createLabelElement(label, ticketNumber, false);
                jiraLabelsContainer.appendChild(labelEl);
            });

            // Insérer les labels Jira après le titre (seulement si au moins un label existe)
            if (jiraLabelsContainer.children.length > 0) {
                titleLink.parentElement.appendChild(jiraLabelsContainer);
            }

        } catch(e) {
            console.error('Error processing PR row:', e);
        }
    }
}

async function handlePrPage() {
    const titleEl = document.querySelector('h1 > span.markdown-title');
    const insertedJiraDataEl = document.querySelector('#insertedJiraData');
    const pageHeaderDescriptionEl = document.querySelector('[class^="prc-PageHeader-Description"]');
    if (!titleEl || insertedJiraDataEl) {
        //If we didn't find a ticket, or the data is already inserted, cancel.
        return false;
    }

    const title = titleEl.innerHTML;

    const [ticketNumber] = title.match(/([A-Z0-9]+-[0-9]+)/);
    if (!ticketNumber) {
        // Title was found, but ticket number wasn't.
        return false;
    }

    //Replace title with clickable link to jira ticket
    titleEl.innerHTML = titleHTMLContent(title, ticketNumber);

    //Open up a handle for data
    const loadingElement = buildLoadingElement(ticketNumber);
    pageHeaderDescriptionEl.appendChild(loadingElement);

    //Load up data from jira
    try {
        const result = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber })
        if (result.errors) {
            throw new Error(result.errorMessages);
        }
        loadingElement.innerHTML = headerBlock(ticketNumber, result.fields);
    } catch(e) {
        console.error('Error fetching data', e)
        loadingElement.innerText = e.message;
    }
}

async function handlePrCreatePage() {
    if (prTitleEnabled == false && prTemplateEnabled == false) {
        return;
    }

    let body = document.querySelector('textarea#pull_request_body');
    if (!body) {
        return;
    }

    if (body.getAttribute('jira-loading') === 'true') {
        return false; //Already loading
    }
    body.setAttribute('jira-loading', 'true');

    const title = document.title;
    let ticketUrl = '**No linked ticket**';
    let acceptanceList = '';
    let ticketNumber = '?';
    if (title) {
        const titleMatch = title.match(/([a-zA-Z]+-[0-9]+)/);
        if (titleMatch) {
            // Found a title, fetch some info from the ticket
            // Get the last one in the list.
            ticketNumber = titleMatch[titleMatch.length - 1];
            ticketUrl = getJiraUrl(ticketNumber);

            //Load up data from jira
            try {
                const {
                    fields: { summary, description: orgDescription },
                    errors = false,
                    errorMessages = false
                } = {} = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber });
                if (errors) {
                    throw new Error(errorMessages)
                }

                if (prTitleEnabled) {
                    document.querySelector('input#pull_request_title').value = `[${ticketNumber.toUpperCase()}] ${summary}`;
                }

                let description = orgDescription
                if (typeof description == 'string') {
                    description = description.substr(description.indexOf(acceptanceStartString), description.length);
                    description = description.substr(0, description.indexOf(acceptanceEndString));
                    description = description.substr(acceptanceStartString.length, description.length - acceptanceEndString.length);

                    acceptanceList = description.replace(/#/g, '- [ ]').replace(/^\s+|\s+$/g, '');
                }
            } catch(e) {
                console.error('Could not get remote data', e)
            }
        }
    }

    if (prTemplateEnabled && body.value === '') {
        const nextBodyValue = prTemplate
            .replace('{{TICKETURL}}', ticketUrl)
            .replace('{{TICKETNUMBER}}', ticketNumber)
            .replace('{{ACCEPTANCE}}', acceptanceList);
        body.value = nextBodyValue;
    }
}
