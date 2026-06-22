// WebScout - Lead Finder Logic

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const CATEGORY_QUERIES = {
  "all": [
    ["shop", null],
    ["craft", null],
    ["office", null],
    ["amenity", "restaurant"],
    ["amenity", "cafe"]
  ],
  "auto": [
    ["shop", "car_repair"],
    ["shop", "car"],
    ["shop", "tyres"]
  ],
  "cleaning": [
    ["shop", "cleaning"],
    ["craft", "cleaning"]
  ],
  "contractors": [
    ["craft", null],
    ["office", "company"]
  ],
  "electricians": [
    ["craft", "electrician"]
  ],
  "lawn": [
    ["shop", "garden_centre"],
    ["craft", "gardener"],
    ["craft", "landscaper"]
  ],
  "plumbers": [
    ["craft", "plumber"]
  ],
  "restaurants": [
    ["amenity", "restaurant"],
    ["amenity", "cafe"],
    ["amenity", "fast_food"],
    ["amenity", "bar"],
    ["amenity", "pub"]
  ],
  "retail": [
    ["shop", null]
  ]
};

// State management
let state = {
  bbox: null,
  leads: [],
  filteredLeads: [],
  map: null,
  markerGroup: null,
  isScanning: false
};

// DOM elements
const els = {
  searchForm: document.getElementById("searchForm"),
  placeInput: document.getElementById("placeInput"),
  limitSlider: document.getElementById("limitSlider"),
  limitVal: document.getElementById("limitVal"),
  searchBtn: document.getElementById("searchBtn"),
  consoleLog: document.getElementById("consoleLog"),
  logStatus: document.getElementById("logStatus"),
  statTotal: document.getElementById("statTotal"),
  statNoWebsite: document.getElementById("statNoWebsite"),
  statPhone: document.getElementById("statPhone"),
  statEmail: document.getElementById("statEmail"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  tableFilterInput: document.getElementById("tableFilterInput"),
  tableSortSelect: document.getElementById("tableSortSelect"),
  leadsTableBody: document.getElementById("leadsTableBody")
};

// Initialize app
function init() {
  initMap();
  bindEvents();
  lucide.createIcons();
}

// Initialize Leaflet Map
function initMap() {
  // Center on Austin initially
  state.map = L.map("map").setView([30.2672, -97.7431], 12);
  
  // Use CartoDB Dark Matter tiles (beautiful free dark theme)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20
  }).addTo(state.map);
  
  state.markerGroup = L.layerGroup().addTo(state.map);
}

// Write to side console log
function writeLog(text, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const logClass = isError ? "error-log" : "";
  els.consoleLog.innerHTML += `\n<span class="${logClass}">[${timestamp}] ${text}</span>`;
  els.consoleLog.scrollTop = els.consoleLog.scrollHeight;
}

function clearLog() {
  els.consoleLog.innerHTML = "";
}

// Bind event listeners
function bindEvents() {
  // Update limit text on slider move
  els.limitSlider.addEventListener("input", (e) => {
    els.limitVal.textContent = e.target.value;
  });

  // Handle category checkboxes logic: "all" mutually excludes others
  const allCb = document.querySelector("input[name='category'][value='all']");
  const otherCbs = Array.from(document.querySelectorAll("input[name='category']:not([value='all'])"));
  
  if (allCb) {
    allCb.addEventListener("change", () => {
      if (allCb.checked) {
        otherCbs.forEach(cb => cb.checked = false);
      }
    });
    
    otherCbs.forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) {
          allCb.checked = false;
        }
      });
    });
  }

  // Search form submit
  els.searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.isScanning) return;
    
    const place = els.placeInput.value.trim();
    const checkedCats = Array.from(document.querySelectorAll("input[name='category']:checked"))
      .map(cb => cb.value);
    const limit = parseInt(els.limitSlider.value, 10);
    
    if (checkedCats.length === 0) {
      alert("Please select at least one category to scan.");
      return;
    }
    
    await runScan(place, checkedCats, limit);
  });

  // Table client-side filter
  els.tableFilterInput.addEventListener("input", (e) => {
    filterLeads(e.target.value);
  });

  // Table client-side sort
  els.tableSortSelect.addEventListener("change", (e) => {
    sortLeads(e.target.value);
  });

  // Export buttons
  els.exportCsvBtn.addEventListener("click", exportCSV);
  els.exportJsonBtn.addEventListener("click", exportJSON);
}

// Run full location OSINT scan
async function runScan(place, categories, limit) {
  state.isScanning = true;
  els.searchBtn.disabled = true;
  els.searchBtn.querySelector("span").textContent = "Scanning...";
  els.searchBtn.querySelector("i").classList.add("spinning");
  els.logStatus.textContent = "Scanning";
  els.logStatus.className = "status-indicator scanning";
  
  clearLog();
  writeLog(`Starting scan for "${place}"...`);
  
  try {
    // 1. Geocode location to bounding box via Nominatim
    writeLog("Querying Nominatim for coordinates...");
    const bbox = await geocodePlace(place);
    state.bbox = bbox;
    writeLog(`Geocoded bounding box: South=${bbox[0]}, West=${bbox[1]}, North=${bbox[2]}, East=${bbox[3]}`);
    
    // Zoom map to the search area
    state.map.fitBounds([
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]]
    ]);
    
    // 2. Query Overpass API for businesses in bbox without website tags
    writeLog("Building Overpass query...");
    const query = buildOverpassQuery(bbox, categories);
    
    writeLog("Sending request to OpenStreetMap Overpass API (this may take up to 20s)...");
    const elements = await fetchOSM(query);
    writeLog(`Received ${elements.length} raw business elements from OpenStreetMap.`);
    
    // 3. Process records into structured leads
    const processedLeads = elements
      .map(el => parseOSMElement(el))
      .filter(lead => lead !== null)
      .slice(0, limit);
      
    state.leads = processedLeads;
    state.filteredLeads = [...processedLeads];
    
    writeLog(`Successfully filtered & processed ${processedLeads.length} leads without website tags.`);
    
    // 4. Update UI: Map, Stats, and Table
    updateDashboard();
    
    // Enable controls
    els.tableFilterInput.disabled = false;
    els.tableSortSelect.disabled = false;
    els.exportCsvBtn.disabled = false;
    els.exportJsonBtn.disabled = false;
    
    writeLog("Scan completed successfully! Review your leads below.");
  } catch (err) {
    console.error(err);
    writeLog(`Scan failed: ${err.message}`, true);
    alert(`Error scanning: ${err.message}`);
  } finally {
    state.isScanning = false;
    els.searchBtn.disabled = false;
    els.searchBtn.querySelector("span").textContent = "Scan Location";
    els.searchBtn.querySelector("i").classList.remove("spinning");
    els.logStatus.textContent = "Idle";
    els.logStatus.className = "status-indicator idle";
  }
}

// Nominatim Geocoding API Request
async function geocodePlace(place) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(place)}&format=jsonv2&limit=1`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });
  
  if (!response.ok) {
    throw new Error(`Nominatim error: ${response.statusText}`);
  }
  
  const data = await response.json();
  if (data.length === 0) {
    throw new Error(`Location "${place}" could not be geocoded. Try a broader term.`);
  }
  
  const bbox = data[0].boundingbox.map(Number); // [south, north, west, east]
  // Return in Overpass format: [south, west, north, east]
  return [bbox[0], bbox[2], bbox[1], bbox[3]];
}

// Build Overpass QL Query
function buildOverpassQuery(bbox, categories) {
  const bboxText = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  const queries = [];
  const seenRules = new Set();
  
  categories.forEach(cat => {
    const rules = CATEGORY_QUERIES[cat] || [];
    rules.forEach(rule => {
      const key = rule[0];
      const val = rule[1];
      const ruleKey = `${key}:${val}`;
      if (seenRules.has(ruleKey)) return;
      seenRules.add(ruleKey);
      
      const filterStr = '[!"website"][!"contact:website"][!"url"][!"contact:url"]';
      if (val === null) {
        queries.push(`nwr["${key}"]${filterStr}(${bboxText});`);
      } else {
        queries.push(`nwr["${key}"="${val}"]${filterStr}(${bboxText});`);
      }
    });
  });
  
  const body = queries.join("\n  ");
  return `[out:json][timeout:60];
(
  ${body}
);
out center tags;`;
}

// Overpass API Request
async function fetchOSM(query) {
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    }
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Overpass API error: ${text || response.statusText}`);
  }
  
  const data = await response.json();
  return data.elements || [];
}

// Parse OSM raw element into lead data structure
function parseOSMElement(element) {
  const tags = element.tags || {};
  const name = tags.name ? tags.name.trim() : "";
  if (!name) return null; // Ignore unnamed nodes
  
  // Extract coordinate
  const lat = element.lat || (element.center && element.center.lat);
  const lon = element.lon || (element.center && element.center.lon);
  if (!lat || !lon) return null;
  
  // Build address
  const streetParts = [
    tags["addr:housenumber"] || "",
    tags["addr:street"] || "",
    tags["addr:city"] || "",
    tags["addr:state"] || "",
    tags["addr:postcode"] || ""
  ].map(p => p.trim()).filter(p => p);
  
  const address = streetParts.join(" ") || "No address tag in OSM";
  
  // Contact details
  const phone = tags.phone || tags["contact:phone"] || "";
  const email = tags.email || tags["contact:email"] || "";
  
  // Category mapping
  let category = "Local Business";
  for (const cat of Object.keys(CATEGORY_QUERIES)) {
    const rules = CATEGORY_QUERIES[cat];
    const match = rules.some(rule => {
      const key = rule[0];
      const val = rule[1];
      if (val === null) {
        return tags[key] !== undefined;
      }
      return tags[key] === val;
    });
    if (match) {
      category = cat.charAt(0).toUpperCase() + cat.slice(1);
      break;
    }
  }
  
  // OSM Type map
  const typeMap = { "node": "node", "way": "way", "relation": "relation" };
  const osmUrl = `https://www.openstreetmap.org/${typeMap[element.type]}/${element.id}`;
  
  return {
    id: `${element.type}-${element.id}`,
    name,
    category,
    address,
    phone,
    email,
    lat,
    lon,
    osmUrl
  };
}

// Update Map, Stats, and Table based on current state
function updateDashboard() {
  updateStats();
  updateMapMarkers();
  renderTable();
  if (state.map) {
    state.map.invalidateSize();
  }
}

function updateStats() {
  els.statTotal.textContent = state.leads.length;
  els.statNoWebsite.textContent = state.filteredLeads.length;
  
  const phoneCount = state.filteredLeads.filter(l => l.phone).length;
  const emailCount = state.filteredLeads.filter(l => l.email).length;
  
  els.statPhone.textContent = phoneCount;
  els.statEmail.textContent = emailCount;
}

function updateMapMarkers() {
  state.markerGroup.clearLayers();
  
  state.filteredLeads.forEach(lead => {
    const customIcon = L.divIcon({
      className: "custom-glow-pin",
      html: `<div class="marker-pin-glow"></div><div class="marker-pin-dot"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    
    const marker = L.marker([lead.lat, lead.lon], { icon: customIcon });
    
    // Popup HTML
    const place = els.placeInput.value.trim();
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent('"' + lead.name + '" ' + place + ' official website')}`;
    
    const popupContent = `
      <div class="popup-details">
        <h4>${lead.name}</h4>
        <p><strong>Category:</strong> ${lead.category}</p>
        <p><strong>Address:</strong> ${lead.address}</p>
        ${lead.phone ? `<p><strong>Phone:</strong> ${lead.phone}</p>` : ""}
        ${lead.email ? `<p><strong>Email:</strong> ${lead.email}</p>` : ""}
        <div class="popup-actions">
          <a href="${searchUrl}" target="_blank" class="popup-btn primary">
            <i data-lucide="globe-2"></i> Verify Website
          </a>
          <a href="${lead.osmUrl}" target="_blank" class="popup-btn">
            <i data-lucide="map-pin"></i> OSM Source
          </a>
        </div>
      </div>
    `;
    
    marker.bindPopup(popupContent, { minWidth: 260 });
    
    // Bind popup open callback to render icons in popup
    marker.on("popupopen", () => {
      lucide.createIcons();
    });
    
    state.markerGroup.addLayer(marker);
  });
}

function renderTable() {
  if (state.filteredLeads.length === 0) {
    els.leadsTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-row">
          <div class="empty-state">
            <i data-lucide="search-code"></i>
            <h4>No leads match current filter</h4>
            <p>Try refining your filter text in the box above.</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }
  
  const place = els.placeInput.value.trim();
  
  els.leadsTableBody.innerHTML = state.filteredLeads.map(lead => {
    const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent('"' + lead.name + '" ' + place + ' official website')}`;
    
    return `
      <tr>
        <td>
          <strong style="color: var(--text-primary); font-size: 0.95rem;">${lead.name}</strong>
        </td>
        <td>
          <span class="lead-cat-badge">${lead.category}</span>
        </td>
        <td>
          <span style="color: var(--text-secondary); font-size: 0.82rem;">${lead.address}</span>
        </td>
        <td>
          <div class="lead-contact-info">
            <span class="contact-pill ${lead.phone ? "" : "missing"}">
              <i data-lucide="phone" class="${lead.phone ? "available" : "unavailable"}"></i>
              ${lead.phone || "No phone listed"}
            </span>
            <span class="contact-pill ${lead.email ? "" : "missing"}">
              <i data-lucide="mail" class="${lead.email ? "available" : "unavailable"}"></i>
              ${lead.email || "No email listed"}
            </span>
          </div>
        </td>
        <td>
          <div class="action-buttons">
            <button class="action-btn" onclick="focusOnLead('${lead.id}')" title="Center on Map">
              <i data-lucide="map"></i>
            </button>
            <a href="${googleSearchUrl}" target="_blank" class="action-btn verify" title="Verify Website on Google">
              <i data-lucide="search"></i>
            </a>
            <a href="${lead.osmUrl}" target="_blank" class="action-btn" title="Open OSM Source">
              <i data-lucide="link"></i>
            </a>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  
  lucide.createIcons();
}

// Center map on clicked lead and open its popup
window.focusOnLead = function(leadId) {
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead) return;
  
  state.map.setView([lead.lat, lead.lon], 16);
  
  // Find marker and open popup
  state.markerGroup.eachLayer(marker => {
    const latLng = marker.getLatLng();
    if (latLng.lat === lead.lat && latLng.lng === lead.lon) {
      marker.openPopup();
    }
  });
};

// Client-side text filter
function filterLeads(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    state.filteredLeads = [...state.leads];
  } else {
    state.filteredLeads = state.leads.filter(lead => {
      return lead.name.toLowerCase().includes(q) ||
             lead.category.toLowerCase().includes(q) ||
             lead.address.toLowerCase().includes(q);
    });
  }
  updateDashboard();
}

// Client-side sorter
function sortLeads(method) {
  if (method === "name") {
    state.filteredLeads.sort((a, b) => a.name.localeCompare(b.name));
  } else if (method === "category") {
    state.filteredLeads.sort((a, b) => a.category.localeCompare(b.category));
  } else if (method === "contact") {
    // Show contacts with phone/email first
    state.filteredLeads.sort((a, b) => {
      const aVal = (a.phone ? 1 : 0) + (a.email ? 1 : 0);
      const bVal = (b.phone ? 1 : 0) + (b.email ? 1 : 0);
      return bVal - aVal;
    });
  }
  renderTable();
}

// Export files
function exportCSV() {
  if (state.filteredLeads.length === 0) return;
  
  const headers = ["Name", "Category", "Address", "Phone", "Email", "OSM URL", "Latitude", "Longitude"];
  const rows = state.filteredLeads.map(lead => [
    `"${lead.name.replace(/"/g, '""')}"`,
    `"${lead.category}"`,
    `"${lead.address.replace(/"/g, '""')}"`,
    `"${lead.phone}"`,
    `"${lead.email}"`,
    `"${lead.osmUrl}"`,
    lead.lat,
    lead.lon
  ]);
  
  const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  const cleanPlace = els.placeInput.value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.href = url;
  link.setAttribute("download", `webscout_leads_${cleanPlace}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportJSON() {
  if (state.filteredLeads.length === 0) return;
  
  const jsonContent = JSON.stringify(state.filteredLeads, null, 2);
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  const cleanPlace = els.placeInput.value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.href = url;
  link.setAttribute("download", `webscout_leads_${cleanPlace}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Boot up
window.onload = init;
