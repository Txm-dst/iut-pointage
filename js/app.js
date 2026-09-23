/* ==========================================================
   CONFIG
   ========================================================== */
   const API_URL = "/api/edt";
   const TZ = "Europe/Paris";
   const ETUDIANTS_KEY = "iutEtudiants"; // clé localStorage
   
   // Arborescence ADE
   const ARBORESCENCE = {
       "BUT1": {
           "BUT1-TD1": ["BUT1-TPA", "BUT1-TPB"],
           "BUT1-TD2": ["BUT1-TPC", "BUT1-TPD"],
           "BUT1-TD3": ["BUT1-TPE"]
       },
       "BUT2": {
           "BUT2-TD1": ["BUT2-TPA-PA", "BUT2-TPB-PA"],
           "BUT2-TD2": ["BUT2-TPC-PB", "BUT2-TPD-PB"],
           "BUT2-TD3-APP": ["BUT2-TD3-APP-PA", "BUT2-TD3-APP-PB"]
       },
       "BUT3": {
           "BUT3-TD1": ["BUT3-TPA", "BUT3-TPB"],
           "BUT3-TD2-APP": ["BUT3-TD2-PA"],
           "BUT3-TD3-APP": ["BUT3-TD3-PB"]
       }
   };
   
   const FEUILLES = {};
   for (const [niveau, tds] of Object.entries(ARBORESCENCE)) {
       FEUILLES[niveau] = [];
       for (const [td, groupes] of Object.entries(tds)) {
           FEUILLES[td] = [...groupes];
           groupes.forEach(g => {
               FEUILLES[g] = [g];
               FEUILLES[niveau].push(g);
           });
       }
   }
   const TOUTES_LES_FEUILLES = new Set(
       Object.values(ARBORESCENCE).flatMap(tds => Object.values(tds).flat())
   );
   
   // Liste par défaut avec rôles
   const ETUDIANTS_DEFAUT = [
       { id_etudiants: 1, Nom: "Dupont", Prenom: "Jean", Numero_etu: "E2026001", Groupe: "BUT3-TD2-PA", id_groupe: 1, id_nfc: "391583036585", role: "eleve" },
       { id_etudiants: 2, Nom: "Tuteur", Prenom: "Professeur", Numero_etu: "P2026001", Groupe: "Intervenant", id_groupe: 2, id_nfc: "3674494601", role: "prof" }
   ];
   
   /* ==========================================================
      ÉTAT
      ========================================================== */
   let etudiants = [];
   let tousLesCoursExtraits = [];
   let jourSelectionne = "";
   let premierChargement = true;
   let currentGestionMode = 'eleve'; // Mode actif dans gestion.html ('eleve' ou 'prof')
   
   /* ==========================================================
      OUTILS DATES & SECU
      ========================================================== */
   const fmtCle = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
   const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
   const fmtJourLong = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
   
   function cleJour(date) { return fmtCle.format(date); }
   
   function decalerCle(cle, delta) {
       const d = new Date(cle + "T12:00:00Z");
       d.setUTCDate(d.getUTCDate() + delta);
       return d.toISOString().slice(0, 10);
   }
   
   function icalVersDate(t) {
       if (t.zone && t.zone.tzid === 'floating') {
           return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
       }
       return t.toJSDate();
   }
   
   function escapeHtml(valeur) {
       return String(valeur ?? "")
           .replace(/&/g, "&amp;")
           .replace(/</g, "&lt;")
           .replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;")
           .replace(/'/g, "&#39;");
   }
   
   /* ==========================================================
      CONNEXION
      ========================================================== */
   function handleLogin(event) {
       event.preventDefault();
       const usernameInput = document.getElementById('username').value.trim();
       const passwordInput = document.getElementById('password').value.trim();
       const errorEl = document.getElementById('login-error');
   
       if (usernameInput === "admin" && passwordInput === "admin123") {
           sessionStorage.setItem('iutAuth', '1');
           location.href = 'edt.html';
       } else if (errorEl) {
           errorEl.innerText = "Identifiant ou mot de passe incorrect.";
           errorEl.hidden = false;
       } else {
           alert("Identifiant ou mot de passe incorrect !");
       }
   }
   
   function logout() {
       sessionStorage.removeItem('iutAuth');
       location.href = 'index.html';
   }
   
   /* ==========================================================
      PERSISTANCE
      ========================================================== */
   function loadEtudiants() {
       try {
           const brut = localStorage.getItem(ETUDIANTS_KEY);
           if (brut) return JSON.parse(brut);
       } catch (err) {
           console.error("Lecture des étudiants impossible :", err);
       }
       return ETUDIANTS_DEFAUT.map(e => ({ ...e }));
   }
   
   function saveEtudiants() {
       try {
           localStorage.setItem(ETUDIANTS_KEY, JSON.stringify(etudiants));
       } catch (err) {
           console.error("Enregistrement impossible :", err);
       }
   }
   
   /* ==========================================================
      NAVIGATION JOUR PAR JOUR (EDT)
      ========================================================== */
   function changerJour(delta) {
       const sauterVides = document.getElementById('edt-skip-empty').checked;
       if (sauterVides) {
           const jours = [...new Set(getCoursFiltres().map(c => c.jour))].sort();
           const cible = delta > 0
               ? jours.find(j => j > jourSelectionne)
               : [...jours].reverse().find(j => j < jourSelectionne);
   
           if (!cible) {
               setStatus("Aucun autre jour avec des cours.", "#e67e22");
               return;
           }
           jourSelectionne = cible;
       } else {
           jourSelectionne = decalerCle(jourSelectionne, delta);
       }
       afficherJour();
       applyEDTFilters();
   }
   
   function allerAujourdhui() {
       jourSelectionne = cleJour(new Date());
       afficherJour();
       applyEDTFilters();
   }
   
   function allerAuJour(cle) {
       if (!/^\d{4}-\d{2}-\d{2}$/.test(cle)) return;
       jourSelectionne = cle;
       afficherJour();
       applyEDTFilters();
   }
   
   function afficherJour() {
       const texte = fmtJourLong.format(new Date(jourSelectionne + "T12:00:00Z"));
       document.getElementById('current-date-display').innerText = texte.charAt(0).toUpperCase() + texte.slice(1);
       document.getElementById('edt-date-picker').value = jourSelectionne;
   }
   
   function setStatus(message, couleur) {
       const statusEl = document.getElementById('edt-status');
       if (!statusEl) return;
       statusEl.innerText = message;
       statusEl.style.color = couleur;
   }
   
   /* ==========================================================
      RÉCUPÉRATION ET TRAITEMENT ADE
      ========================================================== */
   async function loadADEData(forcer = false) {
       const tbody = document.getElementById('seances-table');
       const btnRefresh = document.getElementById('btn-refresh-ade');
   
       if (btnRefresh) btnRefresh.classList.add('loading');
       setStatus("Synchronisation avec ADE...", "#3498db");
       tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Téléchargement de l\'emploi du temps...</td></tr>';
   
       try {
           const response = await fetch(API_URL + (forcer ? "?refresh=1" : ""));
           if (!response.ok) throw new Error("Le serveur proxy n'a pas pu joindre ADE (code " + response.status + ")");
   
           const icsText = await response.text();
           if (!icsText.includes("BEGIN:VCALENDAR")) throw new Error("Réponse ADE invalide (format ICS attendu)");
   
           traiterEmploiDuTemps(icsText);

           const obsolete = response.headers.get('X-Cache') === 'STALE';
           setStatus(
               obsolete
                   ? `ADE injoignable : dernières données connues (${tousLesCoursExtraits.length} séances).`
                   : `ADE à jour : ${tousLesCoursExtraits.length} séances au total.`,
               obsolete ? "#e67e22" : "#177A50"
           );
       } catch (err) {
           console.error(err);
           const proxyEteint = err instanceof TypeError;
           setStatus(proxyEteint ? "Erreur réseau ou serveur inaccessible." : err.message, "#EF4444");
           tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#EF4444;">${escapeHtml(err.message)}</td></tr>`;
       } finally {
           if (btnRefresh) btnRefresh.classList.remove('loading');
       }
   }

   function calculerCibles(groupe) {
       if (FEUILLES[groupe]) return FEUILLES[groupe];
       const enfants = [...TOUTES_LES_FEUILLES].filter(f => f.startsWith(groupe + "-"));
       return enfants.length > 0 ? enfants : [groupe];
   }
   
   function libelleCibles(cibles) {
       const restantes = new Set(cibles);
       const libelles = [];
   
       for (const [niveau, tds] of Object.entries(ARBORESCENCE)) {
           if (FEUILLES[niveau].every(f => restantes.has(f))) {
               libelles.push(`${niveau} (toute la promo)`);
               FEUILLES[niveau].forEach(f => restantes.delete(f));
               continue;
           }
           for (const [td, groupes] of Object.entries(tds)) {
               if (groupes.length > 1 && groupes.every(f => restantes.has(f))) {
                   libelles.push(td);
                   groupes.forEach(f => restantes.delete(f));
               }
           }
       }
       return [...libelles, ...restantes];
   }
   
   function traiterEmploiDuTemps(icsText) {
       const comp = new ICAL.Component(ICAL.parse(icsText));
       const coursUniques = new Map();
   
       comp.getAllSubcomponents('vevent').forEach(vevent => {
           const event = new ICAL.Event(vevent);
           const debut = icalVersDate(event.startDate);
           const fin = icalVersDate(event.endDate);
           const description = event.description || "";
   
           const lignes = description.split('\n').map(l => l.trim()).filter(l => l.length > 0);
           const groupes = lignes.filter(l => l.startsWith("BUT"));
           if (groupes.length === 0) return;
   
           const professeur = lignes.find(l => !l.startsWith("BUT") && !l.startsWith("(Exporté le:")) || "";
           const cibles = new Set(groupes.flatMap(calculerCibles));
   
           const cle = [event.summary, debut.getTime(), fin.getTime(), event.location, professeur].join("|");
           if (coursUniques.has(cle)) {
               cibles.forEach(c => coursUniques.get(cle).cibles.add(c));
               return;
           }
   
           coursUniques.set(cle, {
               cours: event.summary || "",
               professeur: professeur,
               salle: event.location || "",
               debut: debut,
               fin: fin,
               jour: cleJour(debut),
               cibles: cibles
           });
       });
   
       tousLesCoursExtraits = [...coursUniques.values()]
           .map(c => ({ ...c, cibles: [...c.cibles].sort() }))
           .sort((a, b) => a.debut - b.debut);
   
       if (premierChargement) {
           premierChargement = false;
           const aDesCours = tousLesCoursExtraits.some(c => c.jour === jourSelectionne);
           if (!aDesCours) {
               const prochain = tousLesCoursExtraits.find(c => c.jour > jourSelectionne);
               if (prochain) jourSelectionne = prochain.jour;
           }
           afficherJour();
       }
   
       updateEDTGroupDropdownOptions();
       applyEDTFilters();
   }
   
   /* ==========================================================
      FILTRES & TABLE EDT
      ========================================================== */
   function updateEDTGroupDropdownOptions() {
       const niveauSelect = document.getElementById('edt-filter-niveau').value;
       const groupeSelect = document.getElementById('edt-filter-groupe');
       const groupeActuel = groupeSelect.value;
   
       const option = (valeur, texte) => `<option value="${escapeHtml(valeur)}">${escapeHtml(texte)}</option>`;
       const valeursValides = new Set();
       const niveaux = niveauSelect === "TOUS" ? Object.keys(ARBORESCENCE) : [niveauSelect];
   
       let html = '<option value="TOUS">Tous les groupes</option>';
   
       niveaux.forEach(niveau => {
           Object.entries(ARBORESCENCE[niveau] || {}).forEach(([td, groupes]) => {
               html += `<optgroup label="${escapeHtml(td)}">`;
               if (groupes.length > 1) {
                   html += option(td, `Tout ${td}`);
                   valeursValides.add(td);
               }
               groupes.forEach(g => {
                   html += option(g, g);
                   valeursValides.add(g);
               });
               html += '</optgroup>';
           });
       });

       const autres = new Set();
       tousLesCoursExtraits.forEach(c => c.cibles.forEach(cible => {
           const dansLeNiveau = niveauSelect === "TOUS" || cible.startsWith(niveauSelect + "-");
           if (dansLeNiveau && !TOUTES_LES_FEUILLES.has(cible)) autres.add(cible);
       }));
       if (autres.size > 0) {
           html += '<optgroup label="Autres (hors arborescence)">';
           [...autres].sort().forEach(g => {
               html += option(g, g);
               valeursValides.add(g);
           });
           html += '</optgroup>';
       }
   
       groupeSelect.innerHTML = html;
       if (valeursValides.has(groupeActuel)) groupeSelect.value = groupeActuel;
   }
   
   function onNiveauChange() {
       updateEDTGroupDropdownOptions();
       applyEDTFilters();
   }
   
   function getCoursFiltres() {
       const niveauSel = document.getElementById('edt-filter-niveau').value;
       const groupeSel = document.getElementById('edt-filter-groupe').value;
       const feuillesVoulues = groupeSel === "TOUS" ? null : (FEUILLES[groupeSel] || [groupeSel]);
   
       return tousLesCoursExtraits.filter(c => {
           const matchesNiveau = niveauSel === "TOUS" || c.cibles.some(cb => cb.startsWith(niveauSel + "-"));
           const matchesGroupe = !feuillesVoulues || c.cibles.some(cb => feuillesVoulues.includes(cb));
           return matchesNiveau && matchesGroupe;
       });
   }
   
   function applyEDTFilters() {
       const coursDuJour = getCoursFiltres().filter(c => c.jour === jourSelectionne);
       const compteur = document.getElementById('edt-count');
       if (compteur) {
           compteur.innerText = coursDuJour.length === 0
               ? "Aucun cours"
               : `${coursDuJour.length} séance${coursDuJour.length > 1 ? 's' : ''}`;
       }
       renderSeancesTable(coursDuJour);
   }
   
   function renderSeancesTable(liste) {
       const tbody = document.getElementById('seances-table');
       if (!tbody) return;
   
       if (liste.length === 0) {
           tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Aucun cours pour cette journée.</td></tr>';
           return;
       }
   
       const maintenant = Date.now();
   
       tbody.innerHTML = liste.map(s => {
           const enCours = maintenant >= s.debut.getTime() && maintenant < s.fin.getTime();
           const badgesGroupes = libelleCibles(s.cibles).map(c =>
               `<span class="badge-groupe">${escapeHtml(c)}</span>`
           ).join('');
   
           return `<tr class="${enCours ? 'seance-en-cours' : ''}">
               <td>${fmtHeure.format(s.debut)} - ${fmtHeure.format(s.fin)}${enCours ? ' <span class="badge-live">En cours</span>' : ''}</td>
               <td><strong>${escapeHtml(s.cours)}</strong></td>
               <td>${escapeHtml(s.professeur) || "Non précisé"}</td>
               <td><code>${escapeHtml(s.salle) || "N/C"}</code></td>
               <td>${badgesGroupes}</td>
           </tr>`;
       }).join('');
   }
   
   /* ==========================================================
      RECHERCHE
      ========================================================== */
   function ligneRecherche(e) {
       return `<tr>
           <td>${escapeHtml(e.Numero_etu)}</td>
           <td>${escapeHtml(e.Nom)}</td>
           <td>${escapeHtml(e.Prenom)}</td>
           <td>${escapeHtml(e.Groupe)}</td>
           <td><code>${escapeHtml(e.id_nfc)}</code></td>
       </tr>`;
   }
   
   function updateGroupDropdown() {
       const select = document.getElementById('group-filter');
       if (!select) return;
       const selection = select.value;
       const groups = [...new Set(etudiants.map(e => e.Groupe))];
   
       select.innerHTML = '<option value="">Tous les groupes</option>' +
           groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
   
       if (groups.includes(selection)) select.value = selection;
   }
   
   function filterStudents() {
       const input = document.getElementById('search-input');
       const select = document.getElementById('group-filter');
       const table = document.getElementById('student-search-table');
       if (!input || !table) return;

       const query = input.value.toLowerCase();
       const selectedGroup = select ? select.value : "";
   
       table.innerHTML = etudiants
           .filter(e => {
               const matchesQuery = e.Nom.toLowerCase().includes(query) ||
                                    e.Prenom.toLowerCase().includes(query) ||
                                    e.Numero_etu.toLowerCase().includes(query) ||
                                    e.id_nfc.toLowerCase().includes(query);
               const matchesGroup = selectedGroup === "" || e.Groupe === selectedGroup;
               return matchesQuery && matchesGroup;
           })
           .map(ligneRecherche)
           .join('');
   }
   
   /* ==========================================================
      GESTION DES UTILISATEURS (MODE DYNAMIQUE ÉLÈVE / PROF)
      ========================================================== */
   function setGestionMode(mode) {
       currentGestionMode = mode;
       
       // Styles des boutons d'onglet
       document.getElementById('btn-mode-eleve').classList.toggle('active', mode === 'eleve');
       document.getElementById('btn-mode-prof').classList.toggle('active', mode === 'prof');

       // Adapter les titres
       document.getElementById('form-title').innerText = mode === 'eleve' ? 'Ajouter un étudiant' : 'Ajouter un professeur';
       document.getElementById('btn-submit-user').innerText = mode === 'eleve' ? 'Enregistrer l\'étudiant' : 'Enregistrer le professeur';
       document.getElementById('table-title').innerText = mode === 'eleve' ? 'Liste des étudiants' : 'Liste des professeurs';

       // Masquer/Afficher le champ de saisie Groupe & la colonne tableau Groupe
       const containerGroupe = document.getElementById('groupe-input-container');
       const thGroupe = document.getElementById('th-groupe');
       const inputGroupe = document.getElementById('new-groupe');

       if (mode === 'prof') {
           containerGroupe.style.display = 'none';
           thGroupe.style.display = 'none';
           inputGroupe.removeAttribute('required');
       } else {
           containerGroupe.style.display = 'block';
           thGroupe.style.display = '';
           inputGroupe.setAttribute('required', 'true');
       }

       renderManagementTable();
   }

   function renderManagementTable() {
       const table = document.getElementById('student-management-table');
       if (!table) return;
       
       // Filtrage strict selon le mode actif
       const listeAffichee = etudiants.filter(e => e.role === currentGestionMode);

       if (listeAffichee.length === 0) {
           table.innerHTML = `<tr><td colspan="8" style="text-align:center;">Aucun ${currentGestionMode === 'eleve' ? 'étudiant' : 'professeur'} enregistré.</td></tr>`;
           return;
       }

       table.innerHTML = listeAffichee.map(e => {
           const isProf = e.role === 'prof';
           const badgeRole = isProf 
               ? `<span style="background-color: #3b82f6; color: white; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 0.8em;">Professeur</span>`
               : `<span style="background-color: #10b981; color: white; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 0.8em;">Étudiant</span>`;
           
           const btnBasculeText = isProf ? 'Passer en Élève' : 'Passer en Prof';
           const cellGroupe = currentGestionMode === 'eleve' ? `<td>${escapeHtml(e.Groupe)}</td>` : '';

           return `<tr>
               <td>${e.id_etudiants}</td>
               <td>${escapeHtml(e.Numero_etu)}</td>
               <td>${escapeHtml(e.Nom)}</td>
               <td>${escapeHtml(e.Prenom)}</td>
               <td>${badgeRole}</td>
               ${cellGroupe}
               <td><code>${escapeHtml(e.id_nfc)}</code></td>
               <td>
                   <button class="btn btn-secondary" style="margin-right: 5px;" onclick="toggleUserRole(${e.id_etudiants})">${btnBasculeText}</button>
                   <button class="btn btn-danger" onclick="deleteStudent(${e.id_etudiants})">Supprimer</button>
               </td>
           </tr>`;
       }).join('');
   }
   
   function simulateNFCScan() {
       const field = document.getElementById('new-id-nfc');
       if (field) field.value = "NFC-" + Math.floor(Math.random() * 899999 + 100000);
   }
   
   function addStudent(e) {
       e.preventDefault();
       const isProfMode = currentGestionMode === 'prof';

       etudiants.push({
           id_etudiants: Date.now(),
           Numero_etu: document.getElementById('new-num-etu').value.trim(),
           Nom: document.getElementById('new-nom').value.trim(),
           Prenom: document.getElementById('new-prenom').value.trim(),
           Groupe: isProfMode ? "Enseignant" : document.getElementById('new-groupe').value.trim(),
           role: currentGestionMode,
           id_groupe: 1,
           id_nfc: document.getElementById('new-id-nfc').value.trim()
       });

       saveEtudiants();
       document.getElementById('add-student-form').reset();
       renderManagementTable();
   }

   function toggleUserRole(id) {
       const user = etudiants.find(e => e.id_etudiants === id);
       if (user) {
           user.role = user.role === 'prof' ? 'eleve' : 'prof';
           if (user.role === 'prof') {
               user.Groupe = "Enseignant";
           }
           saveEtudiants();
           renderManagementTable();
       }
   }
   
   function deleteStudent(id) {
       etudiants = etudiants.filter(e => e.id_etudiants !== id);
       saveEtudiants();
       renderManagementTable();
   }
   
   /* ==========================================================
      INIT
      ========================================================== */
   function initEdtPage() {
       jourSelectionne = cleJour(new Date());
       premierChargement = true;
       afficherJour();
       loadADEData();
   
       const btnRefresh = document.getElementById('btn-refresh-ade');
       if (btnRefresh) btnRefresh.addEventListener('click', () => loadADEData(true));
   
       document.addEventListener('keydown', (e) => {
           if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
           if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
           changerJour(e.key === 'ArrowRight' ? 1 : -1);
       });
   }
   
   function initReecherchePage() {
       etudiants = loadEtudiants();
       updateGroupDropdown();
       filterStudents();
   }
   
   function initGestionPage() {
       etudiants = loadEtudiants();
       setGestionMode('eleve'); // Initialise par défaut sur les élèves
   }
   
   document.addEventListener('DOMContentLoaded', () => {
       if (document.getElementById('seances-table')) initEdtPage();
       else if (document.getElementById('add-student-form')) initGestionPage();
       else if (document.getElementById('student-search-table')) initReecherchePage();

       // Écoute du WebSocket pour les badges NFC
       if (typeof io !== 'undefined') {
           const socket = io();

           socket.on('connect', () => {
               console.log('Connecté au serveur WebSocket NFC !');
           });

           socket.on('nfc-scan', (data) => {
               console.log('Badge NFC reçu :', data.uid);
               const inputNFC = document.getElementById('new-id-nfc');
               if (inputNFC) {
                   inputNFC.value = data.uid;
                   inputNFC.style.border = '2px solid #10b981';
                   setTimeout(() => {
                       inputNFC.style.border = '';
                   }, 1500);
               }
           });
       }
   });