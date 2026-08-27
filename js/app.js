    // Captured as early as possible - Chrome/Android fires this once the
    // page is eligible for installation, and calling .prompt() on it later
    // is the only way to trigger the native "Install app" dialog instead
    // of just linking people to browser-menu instructions.
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
    });

    class VocabularyApp {
      constructor() {
        this.words = this.initializeWords();
        this.allTimeStats = { totalAttempts: 0, totalCorrect: 0 };
        this.sessionActive = false;
        this.currentSession = [];
        this.sessionIndex = 0;
        this.sessionStats = { correct: 0, incorrect: 0, streak: 0 };
        this.lastAction = null; // Last grid mark, for undo
        this.currentStreak = 0; // Consecutive calendar days studied
        this.sessionsToday = 0; // Sessions started today - encourages multiple short visits, not just one/day
        this.lastStudyDate = null; // 'YYYY-MM-DD'
        this.studyHistory = {}; // 'YYYY-MM-DD' -> sessions count, for the progress activity view
        this.friends = {}; // friendUid -> true (Firebase users only, see showFriendsModal)
        this.lastSaved = null;
        this.autoSaveInterval = null;
        this.breakTimerId = null; // Recommends a break after 7 min in one set - see startBreakTimer
        // Which side the last graded card flew off to (1 = right/correct,
        // -1 = left/incorrect, null = no grade just happened) - lets the
        // next card slide in from that same side instead of always using
        // the generic fade-up, so grading reads as one continuous motion
        // instead of a swipe followed by an unrelated pop-in. Cleared after
        // each render so unrelated re-renders (toggling a flag, jumpToWord)
        // fall back to the plain entrance.
        this._lastGradeDir = null;
        this._lastRenderedWordId = null;
        this.currentUser = null; // Firebase user
        this.userSkippedLogin = false; // Track if user skipped login screen
        // True once we know the *authoritative* session/login state:
        // immediately if Firebase isn't configured (nothing async to wait
        // on), otherwise only after auth.onAuthStateChanged's first
        // callback AND (for a logged-in user) that user's cloud progress
        // has actually finished loading - see loadProgressFromFirebase().
        // Gates getScreenType() so a returning user sees a brief loading
        // screen instead of a flash of the login form, or worse, a flash
        // into a stale locally-cached session (e.g. mid-rehearsal) that
        // gets immediately overwritten once the real cloud data arrives.
        this.authChecked = !firebaseReady;
        
        // Difficulty tier: by default the app works through 'easy' words
        // first, then automatically starts introducing 'moderate' once
        // every easy word is mastered (green), then 'hard' once moderate
        // is mastered. A learner can instead pin a specific tier via
        // setDifficultyOverride() - null means "use the automatic
        // progression" (the default). See getCurrentTier().
        this.difficultyOverride = null;

        // Sentence-completion quiz ("games" menu): tests words the learner
        // already marked as known (green), which the normal flashcard
        // session deliberately never shows again (see renderSession's
        // status !== 'green' filter). Entirely ephemeral - the quiz's own
        // question list/index/score never get persisted, only the
        // resulting word.status changes do (via the same saveProgress()
        // path as normal grading), so there's nothing to restore on reload.
        this.sentenceGameActive = false;
        this.sentenceGameQuestions = [];
        this.sentenceGameIndex = 0;
        this.sentenceGameStats = { correct: 0, incorrect: 0 };
        this.sentenceGameAnswered = false;
        this.sentenceGameSelectedId = null;
        this.sentenceGameAddedIds = new Set();
        this.sentenceGameMissedWords = [];
        // Remembered tier/round-size picks from the setup modal (see
        // showSentenceGameSetupModal) - undefined until the learner opens
        // it the first time, at which point startSentenceGame() seeds
        // sensible defaults ('all' tiers, 10 questions).
        this._sentenceSetupTier = undefined;
        this._sentenceSetupSize = undefined;

        // Reading timer
        this.readingTimerActive = false;
        this.readingTimerPaused = false;
        this.readingTimeRemaining = 30 * 60; // 30 minutes in seconds (default)
        this.readingTimeTotal = 30 * 60; // Track total for progress
        this.readingTimerInterval = null;
        
        // Bind keyboard handler
        this.keyboardHandler = this.handleKeyboard.bind(this);
        
        // Load state from Firebase if user is logged in, otherwise from localStorage
        if (firebaseReady && currentUser) {
          this.loadProgressFromFirebase();
        } else {
          this.loadState();
        }
        this.setupKeyboardDetection();
        this.setupBackButtonHandling();
        this.setupAutoSave();
        this.setupSaveFlush();
        this.loadWordOverrides();
        this.render();
      }

      // Owner-authored corrections to a word's spelling/meaning/example,
      // stored in a shared Firebase location (not per-user progress) so a
      // fix made once applies to every device/account instead of just the
      // owner's own copy. Readable by anyone (no login required) so guests
      // browsing before signing in also see corrected text; write access is
      // restricted to the owner account by the `wordOverrides` RTDB rule -
      // see editWordGlobal/saveWordOverride below.
      loadWordOverrides(isRetry) {
        if (!firebaseReady) return;
        db.ref('wordOverrides').once('value')
          .then((snapshot) => {
            if (!snapshot.exists()) return;
            const overrides = snapshot.val();
            let changed = false;
            this.words.forEach(word => {
              const o = overrides[word.id];
              if (o) {
                if (o.english) word.english = o.english;
                if (o.hebrew) word.hebrew = o.hebrew;
                if (o.example) word.example = o.example;
                changed = true;
              }
            });
            if (changed) this.render();
          })
          .catch((error) => {
            // This is the very first Firebase read the app issues, fired
            // synchronously from the constructor before the websocket
            // connection has finished its initial handshake - that specific
            // timing slot can get a spurious permission_denied even with a
            // correct public-read rule, resolving itself a moment later. One
            // retry papers over that startup race instead of leaving the
            // rare affected user permanently missing out on word corrections.
            if (!isRetry && error.code === 'PERMISSION_DENIED') {
              setTimeout(() => this.loadWordOverrides(true), 2000);
              return;
            }
            console.warn('Could not load word overrides:', error.message);
          });
      }
      
      setupAutoSave() {
        // Auto-save every 30 seconds
        this.autoSaveInterval = setInterval(() => {
          if (this.sessionActive) {
            this.saveState();
          }
        }, 30000);
      }
      
      initializeWords() {
        // dueAt/flagged default to explicit null/false (not just a missing
        // key) - Firebase's set() rejects any value containing `undefined`
        // anywhere in the object tree, so every word needs a real value
        // from the start rather than relying on the key being absent.
        return WORDS_DATA.map(w => ({ ...w, dueAt: null, flagged: false, updatedAt: null, failCount: 0, leech: false }));
      }
      
      // Which difficulty tier the user is currently working through. By
      // default this is derived purely from mastery: stay on 'easy' until
      // every easy word is green, then move to 'moderate', then 'hard'.
      // If the learner pinned a tier via setDifficultyOverride(), that
      // tier is returned directly instead. Recomputed on demand (not
      // stored), so it can never go stale relative to this.words.
      getCurrentTier() {
        const tiers = ['easy', 'moderate', 'hard'];
        if (this.difficultyOverride && tiers.includes(this.difficultyOverride)) {
          return this.difficultyOverride;
        }
        for (const tier of tiers) {
          const tierWords = this.words.filter(w => w.difficulty === tier);
          if (tierWords.length === 0) continue; // no words at this tier - skip it
          // Leeches are parked out of rotation, not mastered - but a
          // learner shouldn't be stuck on a tier forever just because one
          // stubborn word hasn't been reactivated. Treat them like green
          // for the purposes of "is this tier done" so the next tier still
          // unlocks (and startNewSession's pool doesn't go empty).
          const allMastered = tierWords.every(w => w.status === 'green' || w.leech);
          if (!allMastered) return tier;
        }
        return 'hard'; // everything mastered - nothing left to advance to
      }

      // Called from the difficulty picker on the start screen. `tier` is
      // 'auto', 'easy', 'moderate', or 'hard' - 'auto' clears the override
      // and restores the default easy->moderate->hard progression.
      setDifficultyOverride(tier) {
        this.difficultyOverride = (tier === 'auto') ? null : tier;
        this.saveProgress();
        this.render();
      }

      startNewSession() {
        // Scope this session to the user's current tier only. This is also
        // the fix for words the user "never studied before" showing up
        // unexpectedly: previously every not-yet-green word across every
        // difficulty (or, in "free" mode, literally all ~3500 words) was
        // immediately eligible for selection, so a session could surface a
        // word from anywhere in the whole remaining pool. Now only the
        // current tier is in play at all.
        const tierWords = this.words.filter(w => w.difficulty === this.getCurrentTier() && w.status !== 'green' && !w.leech);

        if (tierWords.length === 0) {
          // Can happen when a manually pinned tier (see
          // setDifficultyOverride()) is already fully mastered - without
          // this the "התחל שינון" button would just silently do nothing.
          this.showModal('🎉 לא נשארו מילים', '<p style="text-align: center;">שלטת בכל המילים ברמה שנבחרה. אפשר לבחור רמה אחרת, או לעבור למצב אוטומטי.</p>');
          return;
        }

        // Within the tier, also bound how many brand-new (never-attempted)
        // words are "unlocked" for study at once, instead of the entire
        // tier - which can be 1000+ words - being eligible from the first
        // session. Words already attempted before (in progress, or
        // previously missed) are always eligible; new words fill in the
        // remaining room, most exam-relevant first, so new material is
        // introduced gradually as older words get mastered and free up room.
        // Ties (same testProbability) are shuffled rather than sorted by id,
        // since id order reflects when a word was added to the dataset, not
        // its difficulty - sorting by id let the ~500 beginner words added
        // in bulk (all high, sequential ids) cluster solidly at the front
        // of every learner's queue instead of blending in with the rest.
        const ACTIVE_POOL_SIZE = 30;
        const started = tierWords.filter(w => w.updatedAt !== null);
        const notStarted = tierWords
          .filter(w => w.updatedAt === null)
          .sort((a, b) => b.testProbability - a.testProbability || Math.random() - 0.5);
        const activeNotStarted = notStarted.slice(0, Math.max(0, ACTIVE_POOL_SIZE - started.length));
        const pool = [...started, ...activeNotStarted];

        // Real spaced repetition: a word you just got right (red -> orange)
        // rests for a few hours (see markWordKnown) before it's eligible
        // again, instead of being immediately re-drillable. Only words
        // that are actually due get selected into a new session.
        const now = Date.now();
        const due = pool.filter(w => w.status === 'red' || !w.dueAt || w.dueAt <= now);

        if (due.length === 0) {
          this.showRestingModal(pool);
          return;
        }

        this.recordStudySession();

        // Session size: exactly 7 words (or less if not enough words available)
        const sessionSize = Math.min(7, due.length);

        // Weighted random selection based on test probability
        const weighted = this.weightedRandomSelection(due, sessionSize);
        this.currentSession = weighted;

        this.sessionIndex = 0;
        this.sessionStats = { correct: 0, incorrect: 0, streak: 0 };
        this.sessionActive = true;
        // A grade from a previous session shouldn't be undoable once a new
        // one has started - undo() only checks `this.lastAction`, not
        // whether that word is even still in currentSession, so leaving it
        // set would let a stray Undo mutate a word from the session that
        // just ended and decrement the just-reset session/all-time stats.
        this.lastAction = null;
        this.startBreakTimer();
        this.render();
      }

      // Recommends a break 7 minutes into a set - not a hard stop, just a
      // nudge, since a set dragging on that long is usually a sign of
      // fatigue (lots of wrong answers/re-drills), not focus.
      startBreakTimer() {
        this.clearBreakTimer();
        this._armBreakTimer(7 * 60 * 1000);
      }

      _armBreakTimer(ms) {
        this.breakTimerId = setTimeout(() => {
          this.breakTimerId = null;
          this._breakTimerRemainingMs = null;
          this._breakTimerArmedAt = null;
          this.showBreakRecommendationModal();
        }, ms);
        this._breakTimerArmedAt = Date.now();
        this._breakTimerRemainingMs = ms;
      }

      clearBreakTimer() {
        if (this.breakTimerId) {
          clearTimeout(this.breakTimerId);
          this.breakTimerId = null;
        }
        this._breakTimerRemainingMs = null;
        this._breakTimerArmedAt = null;
      }

      // Pauses the 7-minute break-nudge clock while the app is backgrounded
      // (tab switched away, phone locked, or the user goes to the phone's
      // home screen in the installed PWA) - otherwise the countdown keeps
      // running in real time and the modal can fire the instant someone
      // comes back, even though they weren't actually rehearsing.
      pauseBreakTimerForBackground() {
        if (!this.breakTimerId) return;
        const elapsed = Date.now() - this._breakTimerArmedAt;
        const remaining = Math.max(0, this._breakTimerRemainingMs - elapsed);
        clearTimeout(this.breakTimerId);
        this.breakTimerId = null;
        this._breakTimerRemainingMs = remaining;
      }

      resumeBreakTimerFromBackground() {
        if (!this.sessionActive) return;
        if (this._breakTimerRemainingMs == null) return;
        this._armBreakTimer(this._breakTimerRemainingMs);
      }

      showBreakRecommendationModal() {
        const content = `
          <div style="text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">⏰</div>
            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              אתם משננים כבר 7 דקות ברצף. הפסקה קצרה עכשיו ותמשיכו רעננים אחר כך - ריכוז לזמן קצר עובד טוב יותר מריצה ארוכה.
            </p>
            <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
              <button class="btn btn-primary" onclick="app.closeModal(); app.endSession();">בואו נעצור כאן</button>
              <button class="btn btn-secondary" onclick="app.closeModal()">אמשיך עוד קצת</button>
            </div>
          </div>
        `;
        this.showModal('⏰ זמן להפסקה?', content);
      }

      // 'YYYY-MM-DD' in the user's local calendar day, not UTC. toISOString()
      // (used here previously) reports the UTC date, which drifts from the
      // user's actual local date near midnight for any non-UTC timezone -
      // e.g. a session at 1am in Israel (UTC+2/+3) can still read as
      // "yesterday" in UTC, throwing the streak/day-boundary math off by a
      // day depending on time of day and DST.
      getLocalDateKey(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }

      recordStudySession() {
        // Tracks both a day-level streak (don't break the chain) and a
        // same-day session count (multiple short visits per day is how
        // real spaced repetition actually works, not one long daily cram).
        const today = this.getLocalDateKey();
        this.studyHistory[today] = (this.studyHistory[today] || 0) + 1;

        if (this.lastStudyDate === today) {
          this.sessionsToday++;
          return;
        }

        const yesterday = this.getLocalDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
        this.currentStreak = (this.lastStudyDate === yesterday) ? this.currentStreak + 1 : 1;
        this.lastStudyDate = today;
        this.sessionsToday = 1;

        this.maybeCelebrateStreak();
      }

      // Celebrates streak milestones with a warm, positive message - never
      // a "don't break the streak" threat. Research on similar apps found
      // guilt/anxiety-driven streak messaging is a top reason people quit;
      // this only ever shows up as a reward, never a warning.
      maybeCelebrateStreak() {
        const messages = {
          3: 'שלושה ימים ברצף - התחלה מצוינת!',
          7: 'שבוע שלם ברצף! ההתמדה שלך עובדת.',
          14: 'שבועיים ברצף - אתם בונים הרגל אמיתי!',
          30: 'חודש שלם ברצף! זה הישג רציני.',
          50: '50 ימים ברצף - וואו!',
          100: '100 ימים ברצף! מטורף, כל הכבוד.',
          200: '200 ימים ברצף - זה כבר אורח חיים!',
          365: 'שנה שלמה ברצף. פשוט אגדי. 🏆'
        };
        const message = messages[this.currentStreak];
        if (!message) return;

        this.showModal(
          `🔥 ${this.currentStreak} ימים ברצף!`,
          `<div style="text-align: center;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">🎉</div>
            <p style="font-size: 1.05rem; margin-bottom: 1.5rem;">${message}</p>
            <button class="btn btn-secondary" onclick="app.shareApp()">
              📤 ספר לחבר שגם הוא ישנן
            </button>
          </div>`
        );
      }

      // Native share sheet when available (mobile), clipboard-copy fallback
      // otherwise (desktop browsers without navigator.share) - either way
      // the user ends up with a ready-to-send message, never a dead end.
      shareApp() {
        const url = 'https://eilaydror-star.github.io/psychovocab-app/';
        const text = 'אני משנן מילים לפסיכומטרי באפליקציה הזאת - חינמית, עם חזרה מרווחת שעובדת. בוא תנסה גם:';
        if (navigator.share) {
          navigator.share({ title: 'PsychoVocab', text, url }).catch(() => {});
          return;
        }
        const shareText = `${text} ${url}`;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(shareText).then(() => {
            this.showModal('📤 שיתוף', '<p style="text-align: center;">ההודעה הועתקה - אפשר להדביק אותה בוואטסאפ או בכל מקום אחר!</p>');
          }).catch(() => {
            this.showModal('📤 שיתוף', `<p style="text-align: center; margin-bottom: 1rem;">שלח לחבר:</p><p style="text-align: center; direction: ltr; word-break: break-all;">${url}</p>`);
          });
        } else {
          this.showModal('📤 שיתוף', `<p style="text-align: center; margin-bottom: 1rem;">שלח לחבר:</p><p style="text-align: center; direction: ltr; word-break: break-all;">${url}</p>`);
        }
      }

      showRestingModal(restingWords) {
        const now = Date.now();
        const nextDueAt = Math.min(...restingWords.map(w => w.dueAt || now));
        const msRemaining = Math.max(0, nextDueAt - now);
        const minutesRemaining = Math.ceil(msRemaining / 60000);
        const hours = Math.floor(minutesRemaining / 60);
        const mins = minutesRemaining % 60;
        const timeText = hours > 0
          ? `${hours} שעות${mins > 0 ? ' ו-' + mins + ' דקות' : ''}`
          : `${mins} דקות`;

        const content = `
          <div style="text-align: center;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
            <p style="font-size: 1.1rem; margin-bottom: 1.5rem;">
              עשית את החלק שלך להיום! ענית נכון על כל המילים הזמינות כרגע.
            </p>
            <p style="color: var(--text-secondary); margin-bottom: 1.5rem;">
              כדי שהמילים באמת ייקלטו בזיכרון לטווח ארוך, הן צריכות מנוחה לפני שתתבקש לאשר אותן שוב.
            </p>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light);">
              <strong>המנה הבאה תהיה מוכנה בעוד ${timeText}</strong>
            </div>
          </div>
        `;
        this.showModal('🎯 מעולה, חזור מאוחר יותר', content);
      }
      
      weightedRandomSelection(words, count) {
        // Create weighted array where each word is repeated by its test probability
        const weighted = [];
        for (const word of words) {
          // Weight: testProbability determines likelihood of being selected
          // Round to create proper weighting
          let weight = Math.ceil(word.testProbability * 10);

          // Give due orange words (one correct answer away from mastery) a
          // priority boost over brand-new red words. Finishing an
          // almost-mastered word is a visible, complete win ("word turned
          // green") - surfacing those first gives more frequent moments of
          // real progress instead of always diluting the session with new
          // material the learner hasn't even seen once yet.
          if (word.status === 'orange') {
            weight = Math.ceil(weight * 1.5);
          }

          for (let i = 0; i < weight; i++) {
            weighted.push(word);
          }
        }
        
        // Shuffle the weighted array
        const shuffled = weighted.sort(() => Math.random() - 0.5);
        
        // Pick unique words from weighted selection
        const selected = [];
        const selectedIds = new Set();
        
        for (const word of shuffled) {
          if (!selectedIds.has(word.id) && selected.length < count) {
            selected.push(word);
            selectedIds.add(word.id);
          }
        }
        
        return selected;
      }
      
      endSession() {
        this.clearBreakTimer();
        this.sessionActive = false;
        this.saveState();
        this.render();
      }
      
      // Shown automatically (never picked manually) the moment the user
      // masters the last word of a tier and the app advances them into the
      // next one - see markWordKnown().
      showTierUnlockedModal(tier) {
        const tierNames = { easy: '🟢 קל', moderate: '🟡 בינוני', hard: '🔴 קשה' };
        const tierEmoji = { easy: '🟢', moderate: '🟡', hard: '🔴' };

        const content = `
          <div style="text-align: center;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">${tierEmoji[tier]}</div>
            <h2 style="color: var(--teal); margin-bottom: 1rem;">רמה חדשה נפתחה!</h2>
            <p style="font-size: 1.2rem; margin-bottom: 1.5rem;">
              שלטתם בכל המילים ברמה הקודמת! 🎉
            </p>
            <p style="margin-bottom: 1.5rem;">
              מעכשיו יתווספו לשיעורים שלכם גם מילים ברמת <strong>${tierNames[tier]}</strong>
            </p>
            <button class="btn btn-primary" onclick="app.closeModal()">
              מעולה, בואו נמשיך
            </button>
          </div>
        `;

        this.showModal('🎊 הזדמנות חדשה!', content);
      }

      startReadingTimer(minutes = 30) {
        this.readingTimeRemaining = minutes * 60;
        this.readingTimeTotal = minutes * 60;
        this.readingTimerActive = true;
        this.readingTimerPaused = false;
        
        // Clear any existing timer
        if (this.readingTimerInterval) {
          clearInterval(this.readingTimerInterval);
        }
        
        // Update timer every second
        this.readingTimerInterval = setInterval(() => {
          this.readingTimeRemaining--;
          
          // Update display without full re-render
          this.updateTimerDisplay();
          
          if (this.readingTimeRemaining <= 0) {
            clearInterval(this.readingTimerInterval);
            this.readingTimerActive = false;
            this.readingTimerPaused = false;
            this.showReadingCompleteModal();
            this.render();
          }
        }, 1000);
        
        this.render();
      }
      
      pauseReadingTimer() {
        if (this.readingTimerInterval) {
          clearInterval(this.readingTimerInterval);
          this.readingTimerActive = false;
          this.readingTimerPaused = true;
          this.render();
        }
      }
      
      resumeReadingTimer() {
        if (this.readingTimerPaused && this.readingTimeRemaining > 0) {
          this.readingTimerActive = true;
          this.readingTimerPaused = false;

          // Defensive, matching startReadingTimer: clear any interval still
          // running before starting a new one, so two never end up ticking
          // at once (which would double the countdown speed) if this is
          // ever reachable while readingTimerInterval is still live.
          clearInterval(this.readingTimerInterval);
          this.readingTimerInterval = setInterval(() => {
            this.readingTimeRemaining--;
            this.updateTimerDisplay();
            
            if (this.readingTimeRemaining <= 0) {
              clearInterval(this.readingTimerInterval);
              this.readingTimerActive = false;
              this.readingTimerPaused = false;
              this.showReadingCompleteModal();
              this.render();
            }
          }, 1000);
          
          this.render();
        }
      }
      
      updateTimerDisplay() {
        const timerDisplay = document.getElementById('reading-timer-display');
        const progressBar = document.getElementById('reading-timer-progress');
        
        if (timerDisplay) {
          timerDisplay.textContent = this.formatTime(this.readingTimeRemaining);
        }
        
        if (progressBar) {
          const percentage = (this.readingTimeRemaining / this.readingTimeTotal) * 100;
          progressBar.style.width = percentage + '%';
        }
      }
      
      stopReadingTimer() {
        if (this.readingTimerInterval) {
          clearInterval(this.readingTimerInterval);
        }
        this.readingTimerActive = false;
        this.readingTimerPaused = false;
        this.readingTimeRemaining = 30 * 60;
        this.render();
      }
      
      startCustomTimer() {
        const inputElement = document.getElementById('custom-timer-input');
        if (!inputElement) return;
        
        const minutes = parseInt(inputElement.value);
        
        // Validate input
        if (isNaN(minutes) || minutes < 1 || minutes > 180) {
          alert('אנא הכנס מספר בין 1 ל-180 דקות');
          return;
        }
        
        // Start timer with custom minutes
        this.startReadingTimer(minutes);
      }
      
      formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
      
      showReadingCompleteModal() {
        const content = `
          <div style="text-align: center;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">🎉</div>
            <h2 style="color: var(--teal); margin-bottom: 1rem;">סיימת את זמן הקריאה!</h2>
            <p style="font-size: 1.1rem; margin-bottom: 1.5rem;">
              עבודה נהדרת! קראת מספיק ספרים באנגלית היום. 📚
            </p>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <strong>💡 טיפ:</strong> כל יום קריאה משפרת את הצפנון שלך!
            </div>
            <button class="btn btn-primary" onclick="app.closeModal()">
              בסדר, חזור ללימוד
            </button>
          </div>
        `;
        
        this.showModal('⏰ הזמן הסתיים!', content);
      }
      
      showReadingResources() {
        const content = `
          <div style="max-height: 70vh; overflow-y: auto;">
            <div style="margin-bottom: 2rem;">
              <h4 style="color: #51CF66; margin-bottom: 1rem;">🟢 קל - לבניית אוצר מילים בסיסי</h4>
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 BBC Learning English</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  סיפורים קצרים וקלים עם שמע
                </p>
                <a href="https://www.bbc.com/learningenglish" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ BBC Learning English
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 News in Levels - Level 1</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  חדשות אמיתיות בשפה פשוטה במיוחד, עם 500 המילים הנפוצות ביותר
                </p>
                <a href="https://www.newsinlevels.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.newsinlevels.com
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px;">
                <strong>📖 Simple English Wikipedia</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  אותם ערכים כמו בוויקיפדיה הרגילה, אך בשפה ובמשפטים פשוטים
                </p>
                <a href="https://simple.wikipedia.org" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ simple.wikipedia.org
                </a>
              </div>
            </div>

            <div style="margin-bottom: 2rem;">
              <h4 style="color: #FFA500; margin-bottom: 1rem;">🟡 בינוני - ספרים בעלי מורכבות בינונית</h4>
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 Penguin Classics - Abridged</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  ספרים קלאסיים מקוצרים ללימוד יעיל
                </p>
                <a href="https://www.penguin.co.uk" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.penguin.co.uk
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 News in Levels - Level 2/3</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  אותה כתבה ברמת קושי גבוהה יותר, לאחר שהתרגלת לרמה הקלה
                </p>
                <a href="https://www.newsinlevels.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.newsinlevels.com
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 Newsela</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  כתבות חדשות אמיתיות שנכתבות מחדש במספר רמות קריאה
                </p>
                <a href="https://newsela.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ newsela.com
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px;">
                <strong>📖 Medium - Popular Articles</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מאמרים באנגלית על נושאים בעלי עניין
                </p>
                <a href="https://medium.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.medium.com
                </a>
              </div>
            </div>

            <div>
              <h4 style="color: #FF6B6B; margin-bottom: 1rem;">🔴 קשה - ספרים קשים ומעמיקים</h4>
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 Project Gutenberg</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  ספרות קלאסית בחינם - אנגלית עשירה וישנה, מתאים לרמה מתקדמת
                </p>
                <a href="https://www.gutenberg.org" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.gutenberg.org
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 The Guardian - Opinion</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מאמרי דעה מורכבים על נושאים מדיניים, בחינם וללא חומת תשלום
                </p>
                <a href="https://www.theguardian.com/uk/commentisfree" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ The Guardian Opinion
                </a>
              </div>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 Aeon</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מאמרים מעמיקים בשפה מדויקת, בחינם וללא חומת תשלום
                </p>
                <a href="https://aeon.co" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ aeon.co
                </a>
              </div>
              
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px;">
                <strong>📖 Scientific American</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מאמרים מדעיים עמוקים עם טרמינולוגיה מדויקת
                </p>
                <a href="https://www.scientificamerican.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.scientificamerican.com
                </a>
              </div>
            </div>
          </div>
        `;
        
        this.showModal('📚 משאבי קריאה באנגלית', content);
      }

      showFeedbackModal() {
        const content = `
          <div style="line-height: 1.8;">
            <p style="margin-bottom: 1rem;">
              תודה שאתם משתמשים באפליקציה! 🙏
            </p>
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
              זו הגרסה הראשונה (v1) של האפליקציה, ואני עדיין עובד על שיפורה. אם נתקלת בבאג, בתרגום שלא מדויק, או שיש לך רעיון לשיפור - אשמח מאוד לשמוע על כך.
            </p>
            <p style="margin-bottom: 1.5rem; color: var(--text-secondary);">
              אפשר לסמן מילה עם 🚩 ישירות בזמן השינון אם משהו לא נראה נכון, או פשוט לשלוח לי מייל.
            </p>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light); text-align: center; margin-bottom: 1.5rem;">
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.3rem;">יצירת קשר</div>
              <a href="mailto:eilaydror@gmail.com" style="color: var(--sage-green); font-weight: 600; text-decoration: none; font-size: 1.05rem;">eilaydror@gmail.com</a>
            </div>
            <p style="text-align: center; font-weight: 500;">
              בהצלחה במבחן - פסיכומטרי או אמירנט, מה שרלוונטי אליכם. תצליחו! 💪
            </p>
          </div>
        `;
        this.showModal('💌 משוב ויצירת קשר', content);
      }

      handleKeyboard(e) {
        // Ignore if typing in textarea
        if (document.activeElement.tagName === 'TEXTAREA') {
          return;
        }
        // Only meaningful during an active grid session
        if (!this.sessionActive) {
          return;
        }

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const word = this.getCurrentSessionWord();
          if (word) this.attemptGradeKnown(word);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const word = this.getCurrentSessionWord();
          if (word) this.gradeCurrentCard(word, false);
        } else if (e.key === ' ') {
          e.preventDefault();
          this.toggleTranslation();
        } else if (e.key === 'u' || e.key === 'U') {
          e.preventDefault();
          this.undo();
        } else if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          this.goBack();
        }
      }

      // The session shows exactly one word at a time - this returns
      // whichever one that is, matching the same not-mastered/due filter
      // renderSession() uses, so keyboard shortcuts always act on the
      // card actually on screen.
      getCurrentSessionWord() {
        const now = Date.now();
        return this.currentSession.find(w =>
          w.status !== 'green' && (w.status === 'red' || !w.dueAt || w.dueAt <= now)
        );
      }

      // Lets the learner jump straight to any other due word shown in the
      // side list, instead of only ever seeing whichever one happens to be
      // first. Both renderSession() and getCurrentSessionWord() always show
      // currentSession's first active match, so moving the chosen word to
      // the front of the array is all that's needed - no separate "which
      // word is on screen" state to keep in sync.
      jumpToWord(wordId) {
        const idx = this.currentSession.findIndex(w => w.id === wordId);
        if (idx <= 0) return;
        const [word] = this.currentSession.splice(idx, 1);
        this.currentSession.unshift(word);
        this._revealed = false;
        this.render();
      }

      toggleTranslation() {
        const hebrewEl = document.getElementById('hebrew-word');
        const exampleEl = document.getElementById('example-sentence');
        const hintEl = document.getElementById('toggle-hint');
        if (!hebrewEl) return;
        hebrewEl.classList.toggle('hidden');
        const isHidden = hebrewEl.classList.contains('hidden');
        if (exampleEl) exampleEl.classList.toggle('hidden', isHidden);
        if (hintEl) hintEl.style.display = isHidden ? 'block' : 'none';
        if (!isHidden) this._revealed = true;
      }

      // Swiping/pressing "know" only grades the card once the learner has
      // actually seen the translation - the first attempt just reveals it
      // (so they can check themselves), the second one confirms the grade.
      // This stops "know" swipes from being a reflex that skips verification.
      attemptGradeKnown(word) {
        if (this._revealed) {
          this.gradeCurrentCard(word, true);
          return;
        }
        const hebrewEl = document.getElementById('hebrew-word');
        const exampleEl = document.getElementById('example-sentence');
        const hintEl = document.getElementById('toggle-hint');
        if (hebrewEl) hebrewEl.classList.remove('hidden');
        if (exampleEl) exampleEl.classList.remove('hidden');
        if (hintEl) {
          hintEl.textContent = 'עכשיו כשראיתם את התרגום - החליקו שוב ימינה לאישור שאתם יודעים';
          hintEl.style.display = 'block';
          hintEl.style.color = 'var(--sage-green)';
        }
        this._revealed = true;
      }

      goBack() {
        // Exit session and return to menu - automatically save progress
        if (confirm('הגיע לך להפסיק את השיעור? ההתקדמות תישמר.')) {
          this.clearBreakTimer();
          this.saveProgress(); // Auto-save before exiting
          this.sessionActive = false;
          this.sessionIndex = 0;
          // Otherwise pressing undo after starting a brand-new session (or
          // even just leaving without grading anything else) would still
          // act on a word from the session that was just exited - it isn't
          // part of currentSession any more, but undo() doesn't require
          // that, so it would silently mutate a word's status/streak/dueAt
          // from a past session and decrement the just-reset session stats.
          this.lastAction = null;
          this.render();
        }
      }

      undo() {
        // Revert the last markWordKnown/markWordUnknown action
        if (!this.lastAction) return;

        const { word, prevStatus, prevStreak, prevUpdatedAt, prevDueAt, prevFailCount, prevLeech, wasCorrect, prevIndex } = this.lastAction;
        word.status = prevStatus;
        word.streak = prevStreak;
        word.updatedAt = prevUpdatedAt ?? null;
        word.dueAt = prevDueAt ?? null;
        // markWordKnown/markWordUnknown both also touch failCount/leech
        // (a miss increments failCount and can flip leech at the
        // threshold; reaching green resets both) - restore them too, or
        // repeatedly grading wrong then undoing would silently ratchet
        // failCount up on every undo cycle until the word leeches anyway,
        // with undo powerless to reverse a flag it never snapshotted.
        word.failCount = prevFailCount ?? 0;
        word.leech = prevLeech ?? false;

        // If the word had been requeued to the back of the session (a
        // missed word), put it back where it was - or, if it crossed the
        // leech threshold and was pulled out of the session entirely (see
        // markWordUnknown), it won't be in currentSession at all any more,
        // so re-insert it rather than silently leaving it stuck out of
        // rotation even after leech is restored to false above.
        if (typeof prevIndex === 'number' && prevIndex !== -1) {
          const idx = this.currentSession.indexOf(word);
          if (idx !== -1) {
            this.currentSession.splice(idx, 1);
          }
          this.currentSession.splice(Math.min(prevIndex, this.currentSession.length), 0, word);
        }

        if (wasCorrect) {
          this.sessionStats.correct = Math.max(0, this.sessionStats.correct - 1);
          this.allTimeStats.totalCorrect = Math.max(0, this.allTimeStats.totalCorrect - 1);
        } else {
          this.sessionStats.incorrect = Math.max(0, this.sessionStats.incorrect - 1);
        }
        this.allTimeStats.totalAttempts = Math.max(0, this.allTimeStats.totalAttempts - 1);

        this.lastAction = null;
        this.saveProgress();
        this.render();
      }

      updateAssociation(wordId, value) {
        // Save the association/memory aid for the word
        const word = this.words.find(w => w.id === wordId);
        if (word) {
          word.association = value;
          word.updatedAt = Date.now();
          this.saveProgress();
        }
      }

      // Fills the note field with a generated memory-aid suggestion, then
      // saves it like any manually-typed association - the field stays a
      // normal free-text textarea, this just gives it a starting point.
      suggestAssociation(wordId) {
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;
        const suggestion = this.generateAssociationSuggestion(word);
        const textarea = document.getElementById('assoc-' + wordId);
        if (textarea) {
          textarea.value = suggestion;
          textarea.focus();
        }
        this.updateAssociation(wordId, suggestion);
      }

      // Reads an English word aloud using the browser's built-in TTS engine -
      // no external service or per-word audio authoring needed for 3500 words.
      speakWord(source) {
        if (!('speechSynthesis' in window)) return;
        const text = typeof source === 'string' ? source : source?.dataset?.word;
        if (!text) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
      }

      generateAssociationSuggestion(word) {
        const phonetic = this.transliterateToHebrew(word.english);
        const templates = [
          `אפשר לנסות לקרוא את המילה כאילו היא כתובה בעברית: "${phonetic}" - ולקשר את ההגייה הזו למשמעות: "${word.hebrew}".`,
          `תחשוב על ההגייה "${phonetic}" ותדמיין תמונה מוזרה שמקשרת בין הצליל הזה לבין "${word.hebrew}" - ככל שהתמונה מוזרה יותר, כך קל יותר לזכור.`,
          `נסה לפרק את המילה לצלילים: "${phonetic}", ולבנות משפט קצר וזכיר שמחבר בין הצליל הזה למשמעות "${word.hebrew}".`
        ];
        return templates[word.id % templates.length];
      }

      // Rough letter-by-letter English-to-Hebrew phonetic approximation -
      // not linguistically precise, just enough to give the learner a
      // "sounds like" hook for the mnemonic templates above.
      transliterateToHebrew(englishWord) {
        const multiChar = [
          ['tion', 'שן'], ['sion', 'ז׳ן'], ['sh', 'ש'], ['ch', 'צ'], ['th', 'ת'],
          ['ph', 'פ'], ['ck', 'ק'], ['qu', 'קו'], ['oo', 'ו'], ['ee', 'י'],
          ['ea', 'י'], ['ou', 'אאו'], ['ai', 'אי'], ['ay', 'אי'], ['ng', 'נג']
        ];
        const singleChar = {
          a: 'א', b: 'ב', c: 'ק', d: 'ד', e: 'א', f: 'פ', g: 'ג', h: 'ה',
          i: 'אי', j: 'ג׳', k: 'ק', l: 'ל', m: 'מ', n: 'נ', o: 'או', p: 'פ',
          q: 'ק', r: 'ר', s: 'ס', t: 'ת', u: 'או', v: 'ו', w: 'ו', x: 'קס',
          y: 'י', z: 'ז'
        };
        const word = englishWord.toLowerCase();
        let result = '';
        let i = 0;
        while (i < word.length) {
          const rest = word.slice(i);
          const match = multiChar.find(([seq]) => rest.startsWith(seq));
          if (match) {
            result += match[1];
            i += match[0].length;
          } else {
            result += singleChar[word[i]] || '';
            i++;
          }
        }
        return result;
      }
      
      getStats() {
        const mastered = this.words.filter(w => w.status === 'green').length;
        const remaining = this.words.filter(w => w.status !== 'green').length;
        return { mastered, remaining };
      }
      
      saveState() {
        // Persist the in-progress session itself (not just per-word
        // progress) so exiting mid-set and coming back later resumes the
        // exact same set of words in the exact same order, instead of
        // rolling a brand new random session. The words' own status/dueAt/
        // streak (already inside `words` above) already capture every
        // answer given so far in this session - only the session's
        // membership/order and its running tally need to be saved
        // separately. Word objects themselves aren't duplicated here, just
        // their ids, since the full objects already live in `words`.
        const state = {
          words: this.words,
          allTimeStats: this.allTimeStats,
          currentStreak: this.currentStreak,
          sessionsToday: this.sessionsToday,
          lastStudyDate: this.lastStudyDate,
          studyHistory: this.studyHistory,
          sessionActive: this.sessionActive,
          sessionWordIds: this.currentSession.map(w => w.id),
          sessionStats: this.sessionStats,
          difficultyOverride: this.difficultyOverride,
          lastSaved: new Date().toISOString()
        };
        if (saveToLocalStorage(state)) {
          this.lastSaved = new Date();
        }
        
        // Also sync to Firebase if user is logged in
        if (firebaseReady && currentUser) {
          this.syncProgressWithFirebase();
        }
      }
      
      saveProgress() {
        // Automatically save word progress to localStorage AND Firebase.
        // Debounced: markWordKnown/markWordUnknown/updateAssociation (and
        // a few others) each call this on their own, so grading a quick
        // streak of cards - or typing into the association textarea -
        // used to rewrite the entire ~4000-word array to localStorage AND
        // open a brand-new Firebase transaction on every single keystroke/
        // grade, on top of the existing 30s autosave. Collapsing calls that
        // land within a short window into one real save cuts that down
        // without changing when data is guaranteed to be persisted -
        // still far under the 30s autosave interval, and flushed
        // immediately if the tab is closed/hidden before the timer fires
        // (see setupSaveFlush()).
        clearTimeout(this._saveProgressTimer);
        this._saveProgressTimer = setTimeout(() => {
          this._saveProgressTimer = null;
          this.saveState();
        }, 500);
      }

      // Safety net for the debounce above: a save still pending when the
      // tab is closed/backgrounded must not simply be lost.
      setupSaveFlush() {
        const flush = () => {
          if (this._saveProgressTimer) {
            clearTimeout(this._saveProgressTimer);
            this._saveProgressTimer = null;
            this.saveState();
          }
        };
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            flush();
            this.pauseBreakTimerForBackground();
          } else {
            this.resumeBreakTimerFromBackground();
          }
        });
      }
      
      syncProgressWithFirebase() {
        // Save current progress to Firebase
        if (!firebaseReady || !currentUser) {
          console.log('Firebase not ready or user not logged in');
          return;
        }

        const userProgressRef = db.ref(`users/${currentUser.uid}/progress`);

        // Merge per-word by updatedAt inside a transaction, instead of a
        // plain read-then-set. A plain once('value') read followed by a
        // separate set() leaves a window where a second device's write
        // (e.g. two tabs both auto-saving on their 30s interval) lands in
        // between the read and the write here - that write would then be
        // silently clobbered, even though it merged fine against what this
        // device read moments earlier. transaction() re-runs the merge
        // against whatever is actually on the server at write time, so a
        // late-arriving concurrent write can't be lost this way.
        userProgressRef.transaction((remoteData) => {
          const remoteWords = (remoteData && remoteData.words) || [];
          const remoteMap = {};
          remoteWords.forEach(w => { remoteMap[w.id] = w; });

          const mergedWords = this.words.map(localWord => {
            const remoteWord = remoteMap[localWord.id];
            if (remoteWord && (remoteWord.updatedAt || 0) > (localWord.updatedAt || 0)) {
              // The cloud has a newer change for this word (made on
              // another device) - take it instead of overwriting it.
              return {
                ...localWord,
                status: remoteWord.status,
                streak: remoteWord.streak,
                association: remoteWord.association,
                dueAt: remoteWord.dueAt ?? null,
                flagged: remoteWord.flagged ?? false,
                updatedAt: remoteWord.updatedAt ?? null,
                failCount: remoteWord.failCount ?? 0,
                leech: remoteWord.leech ?? false
              };
            }
            return localWord;
          });

          const merged = this.mergeAccumulatedFields(remoteData);
          const { _keepRemoteSession, ...accumulatedFields } = merged;

          return {
            words: mergedWords,
            ...accumulatedFields,
            sessionWordIds: _keepRemoteSession ? ((remoteData && remoteData.sessionWordIds) || []) : this.currentSession.map(w => w.id),
            lastSaved: new Date().toISOString(),
            lastSyncedAt: firebase.database.ServerValue.TIMESTAMP
          };
        })
          .then((result) => {
            // Reflect whatever the transaction actually committed (it may
            // have merged in another device's newer per-word AND
            // accumulated-field changes) back into in-memory state, so this
            // tab's UI stays consistent with what's now on the server
            // instead of silently drifting from it until the next reload.
            if (result.committed && result.snapshot.exists()) {
              const committed = result.snapshot.val();
              const committedWords = committed.words || [];
              const committedMap = {};
              committedWords.forEach(w => { committedMap[w.id] = w; });
              this.words.forEach(localWord => {
                const committedWord = committedMap[localWord.id];
                if (committedWord) Object.assign(localWord, committedWord);
              });
              this.allTimeStats = committed.allTimeStats || this.allTimeStats;
              this.currentStreak = committed.currentStreak ?? this.currentStreak;
              this.sessionsToday = committed.sessionsToday ?? this.sessionsToday;
              this.lastStudyDate = committed.lastStudyDate ?? this.lastStudyDate;
              this.studyHistory = committed.studyHistory ?? this.studyHistory;
              // currentSession itself (the actual word objects, in order)
              // is intentionally left alone here even when the committed
              // sessionActive/sessionWordIds came from another device's
              // in-progress set (see mergeAccumulatedFields) - reconstructing
              // it belongs to restoreSession(), which runs on the next full
              // load, not mid-sync.
            }
            console.log('Progress synced to Firebase');
            this.updatePublicProfile();
          })
          .catch((error) => {
            console.warn('Firebase sync failed, using localStorage:', error.message);
            this.saveState(); // Fallback to localStorage
          });
      }

      // Merges the cumulative/aggregate progress fields (as opposed to
      // per-word data, already merged above) against whatever is currently
      // on the server, instead of blindly overwriting them with this
      // device's own values. Without this, two devices/tabs studying around
      // the same time - each auto-saving on its own 30s timer - take turns
      // clobbering each other's streak/session-count/history with whichever
      // one happened to sync last, even though neither write was wrong on
      // its own.
      mergeAccumulatedFields(remoteData) {
        const remoteStats = (remoteData && remoteData.allTimeStats) || {};
        const allTimeStats = {
          totalAttempts: Math.max(this.allTimeStats.totalAttempts || 0, remoteStats.totalAttempts || 0),
          totalCorrect: Math.max(this.allTimeStats.totalCorrect || 0, remoteStats.totalCorrect || 0)
        };

        // currentStreak/sessionsToday are only meaningful together with the
        // calendar date they belong to - merge them as one unit: same date
        // on both sides takes the higher counters (an in-place merge),
        // different dates take whichever side's date is more recent (the
        // other side is simply stale), never a naive max of unrelated days.
        const remoteLastStudyDate = remoteData && remoteData.lastStudyDate;
        const remoteSessionsToday = (remoteData && remoteData.sessionsToday) || 0;
        const remoteCurrentStreak = (remoteData && remoteData.currentStreak) || 0;
        let lastStudyDate = this.lastStudyDate;
        let sessionsToday = this.sessionsToday;
        let currentStreak = this.currentStreak;
        if (remoteLastStudyDate && remoteLastStudyDate === this.lastStudyDate) {
          sessionsToday = Math.max(this.sessionsToday, remoteSessionsToday);
          currentStreak = Math.max(this.currentStreak, remoteCurrentStreak);
        } else if (remoteLastStudyDate && (!this.lastStudyDate || remoteLastStudyDate > this.lastStudyDate)) {
          lastStudyDate = remoteLastStudyDate;
          sessionsToday = remoteSessionsToday;
          currentStreak = remoteCurrentStreak;
        }

        // studyHistory: union of both sides' date keys, taking the higher
        // session count for any date both sides recorded.
        const studyHistory = { ...((remoteData && remoteData.studyHistory) || {}) };
        Object.keys(this.studyHistory).forEach(date => {
          studyHistory[date] = Math.max(studyHistory[date] || 0, this.studyHistory[date]);
        });

        // sessionActive/sessionStats describe *this device's* in-progress
        // set, not a shared counter - there's nothing meaningful to
        // numerically merge. The only real risk is a device with no active
        // session (e.g. one that just opened the app) overwriting another
        // device's genuinely resumable in-progress session in the cloud -
        // so only let a "no session" write through when the cloud doesn't
        // already have one running.
        const remoteSessionActive = !!(remoteData && remoteData.sessionActive);
        const keepRemoteSession = remoteSessionActive && !this.sessionActive;
        const sessionActive = keepRemoteSession ? true : this.sessionActive;
        const sessionStats = keepRemoteSession ? (remoteData.sessionStats || this.sessionStats) : this.sessionStats;

        // difficultyOverride is a simple device preference, not a counter -
        // just keep whatever this device currently has set.
        const difficultyOverride = this.difficultyOverride;

        return { allTimeStats, currentStreak, sessionsToday, lastStudyDate, studyHistory, sessionActive, sessionStats, difficultyOverride, _keepRemoteSession: keepRemoteSession };
      }

      // Publishes just the stats needed for the friends feature (never
      // per-word progress) to a path any signed-in user can read - lets a
      // friend see your streak/mastered count without exposing your full
      // word-by-word progress. Requires a Firebase security rule allowing
      // authenticated reads on `publicProfiles/{uid}` - see showFriendsModal.
      updatePublicProfile() {
        if (!firebaseReady || !currentUser) return;
        const stats = this.getStats();
        db.ref(`publicProfiles/${currentUser.uid}`).set({
          displayName: currentUser.displayName || (currentUser.email || 'תלמיד').split('@')[0],
          streak: this.currentStreak,
          sessionsToday: this.sessionsToday,
          masteredCount: stats.mastered,
          updatedAt: firebase.database.ServerValue.TIMESTAMP
        }).catch((error) => {
          console.warn('Could not update public profile:', error.message);
        });
      }

      loadProgressFromFirebase() {
        // Load progress from Firebase for current user
        if (!firebaseReady || !currentUser) {
          this.loadProgressFromLocalStorage();
          this.authChecked = true;
          return;
        }

        const userProgressRef = db.ref(`users/${currentUser.uid}/progress`);
        
        userProgressRef.once('value')
          .then((snapshot) => {
            if (snapshot.exists()) {
              const data = snapshot.val();
              console.log('Loaded progress from Firebase');
              
              // Merge saved progress with fresh words - only take the cloud
              // value for a word if it's not older than what's already
              // loaded locally (matters if this fires after local changes
              // were already made this session, e.g. re-auth mid-session).
              const savedWords = data.words || [];
              const freshWords = this.words;

              const savedMap = {};
              savedWords.forEach(w => {
                savedMap[w.id] = w;
              });

              freshWords.forEach(word => {
                const saved = savedMap[word.id];
                if (saved && (saved.updatedAt || 0) >= (word.updatedAt || 0)) {
                  word.status = saved.status;
                  word.streak = saved.streak;
                  word.association = saved.association;
                  word.dueAt = saved.dueAt ?? null;
                  word.flagged = saved.flagged ?? false;
                  word.updatedAt = saved.updatedAt ?? null;
                  word.failCount = saved.failCount ?? 0;
                  word.leech = saved.leech ?? false;
                }
              });

              this.words = freshWords;
              this.allTimeStats = data.allTimeStats || this.allTimeStats;
              this.currentStreak = data.currentStreak ?? this.currentStreak;
              this.sessionsToday = data.sessionsToday ?? this.sessionsToday;
              this.lastStudyDate = data.lastStudyDate ?? this.lastStudyDate;
              this.studyHistory = data.studyHistory ?? this.studyHistory;
              this.difficultyOverride = data.difficultyOverride ?? this.difficultyOverride;
              this.restoreSession(data, freshWords);
              this.authChecked = true;
              this.render();
            } else {
              console.log('No Firebase progress found, using local');
              this.loadProgressFromLocalStorage();
              this.authChecked = true;
              this.render();
            }
            this.loadFriends();
          })
          .catch((error) => {
            console.warn('Failed to load from Firebase:', error.message);
            this.loadProgressFromLocalStorage();
            this.authChecked = true;
            this.render();
          });
      }

      // True when this device has actual guest (not-yet-logged-in) study
      // progress sitting in memory - i.e. this is a device where someone
      // clicked "המשך ללא כניסה" and then graded at least one word, rather
      // than e.g. a fresh page load or a device that only ever used a real
      // account. See handleGuestToAccountTransition() for why this matters.
      hasGuestProgress() {
        if (!this.userSkippedLogin) return false;
        return this.words.some(w => w.updatedAt !== null) || (this.allTimeStats.totalAttempts || 0) > 0;
      }

      // Called instead of loadProgressFromFirebase() when a user who was
      // just studying as a guest on this device signs into (or registers)
      // an account mid-session. loadProgressFromFirebase()'s per-word merge
      // keeps whichever side has the newer `updatedAt` - which sounds right
      // for two devices on the *same* account, but is wrong here: the guest
      // just touched a bunch of words seconds ago, so their fresh (but
      // possibly brand-new/never-really-learned) guest status would always
      // beat the account's real, possibly much more advanced, cloud
      // progress - and the very next auto-save would write that guest data
      // back to the cloud, permanently clobbering it. Instead of merging
      // blindly, ask first.
      handleGuestToAccountTransition() {
        if (!firebaseReady || !currentUser) {
          this.loadProgressFromFirebase();
          return;
        }
        const shouldMerge = confirm(
          'נמצאה התקדמות שנלמדה כאורח במכשיר הזה. האם למזג אותה לתוך ההתקדמות השמורה בחשבון שלך?\n\n' +
          '"אישור" ימזג את שתי ההתקדמויות (מילים שנלמדו לאחרונה כאורח עשויות לדרוס מילים מקבילות מהחשבון).\n' +
          '"ביטול" יתעלם מההתקדמות של האורח ויטען רק את מה ששמור בחשבון שלך.'
        );
        if (!shouldMerge) {
          // Wipe this device's guest state before loading - so the cloud's
          // real progress loads clean, with nothing local left to contest
          // it word-by-word.
          this.words = this.initializeWords();
          this.allTimeStats = { totalAttempts: 0, totalCorrect: 0 };
          this.currentStreak = 0;
          this.sessionsToday = 0;
          this.lastStudyDate = null;
          this.studyHistory = {};
          this.difficultyOverride = null;
          this.sessionActive = false;
          this.currentSession = [];
        }
        this.loadProgressFromFirebase();
      }

      loadFriends() {
        if (!firebaseReady || !currentUser) return;
        db.ref(`users/${currentUser.uid}/friends`).once('value')
          .then((snapshot) => {
            this.friends = snapshot.exists() ? snapshot.val() : {};
          })
          .catch((error) => {
            console.warn('Could not load friends list:', error.message);
          });
      }

      loadProgressFromLocalStorage() {
        // Load from localStorage (fallback)
        this.loadState();
      }

      // Rebuilds this.currentSession/sessionActive/sessionStats from saved
      // data, so a mid-set exit resumes the exact same words in the exact
      // same order instead of always rolling a new session. `words` must
      // already be the fully-merged word list (saved progress applied) so
      // the restored session references the same live objects as
      // this.words, not stale copies. Only "resumes" when there's actually
      // something left to resume - if the saved session had already been
      // fully completed (or the words it referenced no longer exist), it's
      // treated the same as no in-progress session at all, and the next
      // "start" click builds a fresh one via startNewSession().
      restoreSession(data, words) {
        this.sessionStats = (data && data.sessionStats) || { correct: 0, incorrect: 0, streak: 0 };

        const savedIds = data && Array.isArray(data.sessionWordIds) ? data.sessionWordIds : [];
        if (!data || !data.sessionActive || savedIds.length === 0) {
          this.sessionActive = false;
          this.currentSession = [];
          return;
        }

        const wordsById = {};
        words.forEach(w => { wordsById[w.id] = w; });
        const restored = savedIds.map(id => wordsById[id]).filter(Boolean);

        if (restored.length === 0) {
          // Words referenced by the saved session are gone (e.g. word data
          // changed) - nothing left to resume.
          this.sessionActive = false;
          this.currentSession = [];
          return;
        }

        this.currentSession = restored;
        this.sessionActive = true;
        this.sessionIndex = 0;
        this.startBreakTimer();
      }
      
      loadState() {
        const data = loadFromLocalStorage();
        if (data) {
            // Having any saved local progress means this device was
            // already used as a guest before - treat it the same as
            // having explicitly clicked "continue without login", so
            // finishing a resumed session (or any later render, once
            // sessionActive goes back to false) lands on the start
            // screen instead of bouncing back to the login form. Without
            // this, only the in-memory flag set by clicking the button
            // covered that case, which resets on every page load.
            this.userSkippedLogin = true;

            // Keep fresh words but apply saved progress to them
            const savedWords = data.words;
            const freshWords = this.words;
            
            // Create a map of saved word statuses by ID
            const savedStatusMap = {};
            if (savedWords && Array.isArray(savedWords)) {
              savedWords.forEach(w => {
                savedStatusMap[w.id] = { status: w.status, streak: w.streak, association: w.association, dueAt: w.dueAt, flagged: w.flagged, updatedAt: w.updatedAt, failCount: w.failCount, leech: w.leech };
              });
            }

            // Apply saved progress to fresh words
            freshWords.forEach(word => {
              if (savedStatusMap[word.id]) {
                word.status = savedStatusMap[word.id].status;
                word.streak = savedStatusMap[word.id].streak;
                word.association = savedStatusMap[word.id].association;
                word.dueAt = savedStatusMap[word.id].dueAt ?? null;
                word.flagged = savedStatusMap[word.id].flagged ?? false;
                word.updatedAt = savedStatusMap[word.id].updatedAt ?? null;
                word.failCount = savedStatusMap[word.id].failCount ?? 0;
                word.leech = savedStatusMap[word.id].leech ?? false;
              }
            });

            this.words = freshWords; // Use fresh words array
            this.allTimeStats = data.allTimeStats;
            this.currentStreak = data.currentStreak || 0;
            this.sessionsToday = data.sessionsToday || 0;
            this.lastStudyDate = data.lastStudyDate || null;
            this.studyHistory = data.studyHistory || {};
            this.difficultyOverride = data.difficultyOverride || null;
            this.lastSaved = data.lastSaved ? new Date(data.lastSaved) : null;
            this.restoreSession(data, freshWords);
        }
      }
      
      exportProgress() {
        const state = {
          words: this.words,
          allTimeStats: this.allTimeStats,
          currentStreak: this.currentStreak,
          sessionsToday: this.sessionsToday,
          lastStudyDate: this.lastStudyDate,
          studyHistory: this.studyHistory,
          exportDate: new Date().toISOString(),
          version: '1.0'
        };
        
        const dataStr = JSON.stringify(state, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `psychovocab-progress-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
      
      importProgress(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = JSON.parse(e.target.result);
            // Validate the shape before touching this.words/allTimeStats at
            // all - a hand-edited or corrupted file that merely has "words"
            // and "allTimeStats" keys (e.g. words as a string/object, or a
            // word missing `id`) used to pass the old truthy-only check,
            // get assigned into this.words, and only then blow up inside
            // the backwards-compat forEach below or the next render() -
            // by which point this.words was already overwritten with
            // garbage and there's no way back short of reloading the page.
            const isValid = Array.isArray(data.words)
              && data.words.length > 0
              && data.words.every(w => w && typeof w === 'object' && w.id !== undefined && typeof w.english === 'string')
              && data.allTimeStats && typeof data.allTimeStats === 'object';

            if (!isValid) {
              this.showModal('שגיאת ייבוא ❌', '<p>פורמט הקובץ אינו תקף. בחר קובץ שיוצא ממערכת שינון מילים באנגלית.</p>');
              return;
            }

            if (!confirm(`ייבוא הקובץ יחליף את כל ההתקדמות הנוכחית שלך (${this.words.filter(w => w.status !== 'red').length} מילים בתהליך) בזו שבקובץ. להמשיך?`)) {
              return;
            }

            // Backfill every field initializeWords() guarantees on a fresh
            // word, not just association/failCount/leech - a backup
            // exported by an older app version (before dueAt/updatedAt/
            // flagged existed, or before this export itself included
            // streak/history) is otherwise missing keys that the next
            // Firebase sync's transaction() silently drops (undefined
            // fields), and dueAt/updatedAt missing entirely would make
            // startNewSession() treat every imported word as permanently
            // "due", ignoring whatever rest period it should still be in.
            data.words.forEach(word => {
              if (!word.hasOwnProperty('association')) word.association = '';
              if (!word.hasOwnProperty('failCount')) word.failCount = 0;
              if (!word.hasOwnProperty('leech')) word.leech = false;
              if (!word.hasOwnProperty('dueAt')) word.dueAt = null;
              if (!word.hasOwnProperty('updatedAt')) word.updatedAt = null;
              if (!word.hasOwnProperty('flagged')) word.flagged = false;
            });

            this.words = data.words;
            this.allTimeStats = data.allTimeStats;
            this.currentStreak = data.currentStreak || 0;
            this.sessionsToday = data.sessionsToday || 0;
            this.lastStudyDate = data.lastStudyDate || null;
            this.studyHistory = data.studyHistory || {};

            this.saveState();
            this.render();
            this.showModal('ייבוא הצליח! ✅ ✅', `<div class="success-message">ההתקדמות שלך נטענה בהצלחה!</div><p>מילים להשלמה: ${this.words.filter(w => w.status !== 'green').length}</p>`);
          } catch (err) {
            this.showModal('שגיאת ייבוא ❌', '<p>לא יכול לקרוא את הקובץ. וודא שהוא קובץ JSON חוקי שיוצא ממערכת שינון מילים באנגלית.</p>');
          }
        };
        reader.readAsText(file);
        // Reset input so same file can be imported again
        event.target.value = '';
      }
      
      // Any string that came from a Firebase Auth profile (displayName,
      // email) or another user's data (a friend's publicProfiles entry) is
      // untrusted input as far as innerHTML is concerned, even though it
      // looks like plain text most of the time - escape before inserting.
      escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
      }

      showModal(title, content) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = content;
        document.getElementById('modal-overlay').style.display = 'flex';

        // Move keyboard/screen-reader focus into the dialog, and remember
        // what had focus before it opened - a role="dialog" that never
        // receives focus (or never gives it back) is invisible to anyone
        // navigating by keyboard/screen reader, who'd otherwise stay
        // "stuck" on whatever was focused underneath the overlay.
        this._lastFocusedBeforeModal = document.activeElement;
        const modalEl = document.querySelector('#modal-overlay .modal');
        if (modalEl) modalEl.focus();
      }

      closeModal() {
        document.getElementById('modal-overlay').style.display = 'none';
        if (this._lastFocusedBeforeModal && document.contains(this._lastFocusedBeforeModal) && typeof this._lastFocusedBeforeModal.focus === 'function') {
          this._lastFocusedBeforeModal.focus();
        }
        this._lastFocusedBeforeModal = null;
      }

      setupModalClose() {
        const modal = document.getElementById('modal-overlay');
        if (modal) {
          modal.addEventListener('click', (e) => {
            if (e.target === modal) {
              this.closeModal();
            }
          });
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
              this.closeModal();
            }
          });
        }
      }
      
      showExportModal() {
        const lastSavedText = this.lastSaved 
          ? `שנשמר לאחרונה: ${this.lastSaved.toLocaleString()}`
          : 'עדיין אין שומרות';
        
        const content = `
          <p>ההתקדמות שלך נשמרת באופן אוטומטי בהוקד הקובץ המקומי של ההתקן שלך.</p>
          <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.5rem;">${lastSavedText}</p>
          <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border-color);">
            <div style="margin-bottom: 1rem;">
              <strong>📥 גיבוי ההתקדמות שלך</strong>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.5rem;">הורד קובץ גיבוי שתוכל לשחזר בכל עת.</p>
              <button class="btn btn-primary" onclick="app.exportProgress()" style="margin-top: 0.75rem; width: 100%;">
                הורד גיבוי
              </button>
            </div>
            <div style="margin-top: 1rem;">
              <strong>📤 שחזר גיבוי</strong>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.5rem;">העלה קובץ גיבוי שהורדת קודם.</p>
              <label for="file-import" class="file-import-label" style="margin-top: 0.75rem;">
                לחץ להעלאת קובץ גיבוי
              </label>
            </div>
          </div>
        `;
        
        this.showModal('💾 גיבוי נתונים התקדמות', content);
      }
      
      showHelpModal() {
        const content = `
          <div style="max-height: 70vh; overflow-y: auto; direction: rtl;">
            <!-- Hebrew Explanation Only -->
            <div style="background: var(--bg-light); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem; border: 1px solid var(--border-light);">
              <h3 style="color: var(--teal); margin-top: 0; margin-bottom: 1rem;">🧠 מערכת הרמזור - איך זה עובד?</h3>
              
              <p style="margin-bottom: 1rem; line-height: 1.8; color: var(--text-secondary);">
                המוח שלנו אינו בנוי לשנן מידע טכני כל בו זמנית, אלא להסנן רעשים ולשמור רק על מה שחיוני להישרדותו. הדרך היחידה לאותת שמידע מסוים חשוב היא דרך חזרה משכללת הנפגשת איתנו בדיוק כשהמוח מתחיל לשכוח.
              </p>
              
              <p style="margin-bottom: 1rem; line-height: 1.8; color: var(--text-secondary);">
                שימוש בכרטיסי דיגיטליים משולבים עם דירוג כנה של המשתמש—לא יודע, יודע, וביטחון עצמי—יוצר מנגנון משוב מדויק. דירוג זה מאפשר למערכת להתאים אישית את קצב הצגת המילים, למנוע בזבוז זמן על מה שכבר השתרש בזיכרון, ולכוון למקומות חלשים בדיוק.
            </div>
            
            <h3 style="color: var(--teal); margin-bottom: 1rem;">🚦 מערכת הרמזור</h3>
            
            <p style="margin-bottom: 1rem; line-height: 1.8;">כל מילה עוברת דרך שלושה שלבים עד שהיא נשלטת לחלוטין:</p>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 1rem;">
                <strong style="color: #FF6B6B;">🟥 אדום - חדש או טעויות</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.3rem;">המילה חדשה או קיבלת אותה בטעות. צריך ללמוד מחדש!</p>
              </div>
              
              <div style="margin-bottom: 1rem;">
                <strong style="color: #FFA500;">🟧 כתום - זכרת פעם אחת</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.3rem;">זכרת את המילה בפעם הראשונה. אתם בדרך הנכונה!</p>
              </div>
              
              <div>
                <strong style="color: #51CF66;">🟩 ירוק - שולט!</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.3rem;">שרדת ארבעה סבבי חזרה עולים ברצף. המילה נשלטת לטווח ארוך!</p>
              </div>
            </div>

            <h3 style="color: var(--teal); margin: 1.5rem 0 1rem;">🔄 חזרה משכללת</h3>

            <p style="margin-bottom: 1rem; line-height: 1.8;">המערכת משתמשת במדע הוכח: כל תשובה נכונה מרחיקה את המבחן הבא על המילה - כדי לוודא שהיא באמת נחרטת בזיכרון לטווח ארוך, ולא רק שינון רגעי.</p>

            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 1:</strong> למדת מילה → רואה אותה שוב בעוד 4 שעות
              </div>
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 2:</strong> זכרת אותה → רואה אותה שוב בעוד יום
              </div>
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 3:</strong> זכרת שוב → רואה אותה שוב בעוד 3 ימים
              </div>
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 4:</strong> זכרת שוב → רואה אותה שוב בעוד שבוע
              </div>
              <div style="font-size: 0.95rem;">
                <strong>📍 שלב 5:</strong> זכרת גם אחרי שבוע → 🟩 המילה נשלטת סופית!
              </div>
            </div>

            <p style="margin-bottom: 1rem; line-height: 1.8; color: var(--text-secondary); font-size: 0.9rem;">טעות באמצע הדרך? המילה חוזרת ישר לאדום ומתחילה את הסבב מחדש - כך שרק מילים שבאמת נחרתו טוב מגיעות לירוק.</p>

            <h3 style="color: var(--teal); margin: 1.5rem 0 1rem;">💡 טיפים להצלחה</h3>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">✅ עשה שיעורים מרובים ביום להחזקת הזיכרון</div>
              <div style="margin-bottom: 0.8rem;">✅ הוסף קשרים אישיים (לחץ 📝) כדי לזכור טוב יותר</div>
              <div style="margin-bottom: 0.8rem;">✅ אל תדלג על ימים - הזיכרון זקוק לחזרה סדירה</div>
              <div>✅ תרכיז על מילים אדומות (הם החדשות)</div>
            </div>
            
            <h3 style="color: var(--teal); margin: 1.5rem 0 1rem;">🎯 מטרה סופית</h3>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light);">
              <p style="margin: 0;">בעזרת שיעורים קבועים וחזרה משכללת, תשלוט בכל 3,500 המילים! הכל תלוי בעקביות וקשב. בהצלחה! 🚀</p>
            </div>
          </div>
        `;
        
        this.showModal('🚦 מערכת הרמזור - איך זה עובד?', content);
      }
      
      
      resetAllData() {
        this.words = this.initializeWords();
        this.allTimeStats = { totalAttempts: 0, totalCorrect: 0 };
        this.sessionActive = false;
        this.currentSession = [];
        this.sessionIndex = 0;
        this.sessionStats = { correct: 0, incorrect: 0, streak: 0 };
        this.clearBreakTimer();
        this.saveState();
        this.render();
      }
      
      setupKeyboardDetection() {
        document.addEventListener('keydown', this.keyboardHandler);
      }
      
      getScreenType() {
        // While Firebase is still resolving whether a previous session
        // exists, show a loading screen rather than the login form - most
        // visits are a returning, already-logged-in user, so jumping
        // straight to 'login' would flash the login form on every load
        // before immediately flipping to the start screen once auth
        // resolves. Deliberately ignores this.sessionActive here (unlike
        // the checks below) - a locally-cached session isn't trustworthy
        // yet for a Firebase user, since the real cloud progress (which
        // may have no active session at all) hasn't loaded.
        if (!this.authChecked) return 'loading';

        // Show the login screen only when there's nothing else to show
        // instead: no logged-in user, login wasn't explicitly skipped, and
        // there's no session already in progress. Without the sessionActive
        // check here, Firebase finishing its (async, ~1s-after-load) init
        // and flipping firebaseReady to true would bounce a guest user who
        // is mid-session back to the login screen on their very next
        // render() - e.g. the next time they grade a word - even though
        // they never asked to log in or leave the session.
        if (!currentUser && !this.userSkippedLogin && !this.sessionActive) {
          return 'login';
        }
        if (this.sessionActive) return 'session';
        if (this.sentenceGameActive) return 'sentenceGame';
        return 'start';
      }

      setupBackButtonHandling() {
        window.addEventListener('popstate', (e) => {
          const screen = e.state && e.state.screen;
          if (screen) {
            this.applyScreenState(screen);
          }
        });
      }

      applyScreenState(screen) {
        // Reached by pressing the browser/gesture back (or forward) button.
        // Mirror it to an equivalent in-app transition instead of just
        // leaving the underlying data changed but the UI stuck.
        if (screen === 'login') {
          this.userSkippedLogin = false;
        } else if (screen === 'start') {
          this.clearBreakTimer();
          this.sessionActive = false;
          this.sentenceGameActive = false;
        } else if (screen === 'session') {
          this.sessionActive = this.currentSession.length > 0;
        }
        this.saveProgress();
        this._skipNextHistoryPush = true;
        this.render();
      }

      render() {
        const appContent = document.getElementById('app-content');

        const screenType = this.getScreenType();
        if (this._pushedScreen === undefined || this._skipNextHistoryPush) {
          history.replaceState({ screen: screenType }, '', location.href);
          this._skipNextHistoryPush = false;
        } else if (this._pushedScreen !== screenType) {
          history.pushState({ screen: screenType }, '', location.href);
        }
        this._pushedScreen = screenType;

        if (screenType === 'loading') {
          this.renderLoadingScreen(appContent);
          return;
        }

        // Check if user needs to login
        // Show login if: Firebase is ready but no user logged in
        // OR: Login screen should always show on first load (unless user skipped it)
        if (screenType === 'login') {
          this.renderLoginScreen(appContent);
          return;
        }

        const stats = this.getStats();
        
        document.getElementById('total-mastered').textContent = stats.mastered;
        document.getElementById('total-remaining').textContent = stats.remaining;
        document.getElementById('current-streak').textContent = this.currentStreak;
        document.getElementById('sessions-today').textContent = this.sessionsToday;
        
        if (this.sentenceGameActive) {
          this.renderSentenceGame(appContent);
        } else if (!this.sessionActive) {
          this.renderStartScreen(appContent, stats);
        } else {
          this.renderSession(appContent);
        }

        this.setupModalClose();
        this.maybeShowTutorial();
        this.maybeShowInstallPrompt();
      }

      // Auto-shows the beginner's guide exactly once per device, the first
      // time a new user reaches the start screen (never mid-session, so it
      // can't interrupt a drill in progress). Uses its
      // own localStorage key, deliberately not synced through
      // saveState/Firebase - "have I seen the tutorial" is a per-device UI
      // fact, not learning progress.
      maybeShowTutorial() {
        if (this._tutorialCheckDone || this.sessionActive) return;
        this._tutorialCheckDone = true;
        try {
          if (!localStorage.getItem('psychovocab_tutorial_seen')) {
            localStorage.setItem('psychovocab_tutorial_seen', '1');
            this.showFirstRunModal();
          }
        } catch (e) {
          // localStorage unavailable (e.g. private browsing) - just skip
          // the auto-popup, the manual "מדריך למתחילים" button still works.
        }
      }

      // One-time, one-screen welcome for brand-new users - just enough to
      // start the first session without guessing. The full walkthrough
      // (showTutorialModal, below) stays available any time from the
      // "מדריך למתחילים" button for anyone who wants the details.
      showFirstRunModal() {
        const content = `
          <div style="line-height: 1.8; color: var(--text-secondary);">
            <div style="margin-bottom: 0.7rem;">🃏 מילה באנגלית תופיע על כרטיס - לחצו עליו (או Space) כדי לחשוף את התרגום, ואז סמנו בהחלקה או בכפתורים אם ידעתם.</div>
            <div style="margin-bottom: 0.7rem;">🚦 כל מילה מתקדמת מאדום → כתום → ירוק (שולט). הרמה (קל/בינוני/קשה) עולה אוטומטית ברגע ששולטים בכל מילות הרמה הנוכחית.</div>
            <div>⌨️ קיצורי מקלדת: <strong>Space</strong> לחשיפה, <strong>U</strong> לביטול סימון, <strong>B</strong> לחזרה לתפריט.</div>
          </div>
        `;
        this.showModal('👋 ברוכים הבאים ל-PsychoVocab', content);
      }

      showTutorialModal() {
        const content = `
          <div style="max-height: 70vh; overflow-y: auto; direction: rtl;">
            <div style="background: var(--bg-light); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem; border: 1px solid var(--border-light);">
              <h3 style="color: var(--teal); margin-top: 0; margin-bottom: 0.75rem;">👋 ברוך הבא!</h3>
              <p style="margin: 0; line-height: 1.8; color: var(--text-secondary);">
                האפליקציה מלמדת אתכם מילים באנגלית לפסיכומטרי, מילה אחת בכל פעם, עם חזרה חכמה שמתאימה את עצמה לכל מילה. הנה איך זה עובד:
              </p>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🃏 הכרטיס</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">1️⃣ תראו מילה באנגלית. נסו לזכור את התרגום <strong>לפני</strong> שאתם חושפים אותו.</div>
              <div style="margin-bottom: 0.8rem;">2️⃣ לחצו/הקישו על הכרטיס (או Space) כדי לחשוף את התרגום ולבדוק את עצמכם.</div>
              <div>3️⃣ עכשיו סמנו אם ידעתם - זה הצעד שבאמת קובע את ההתקדמות שלכם.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">👉👈 החלקה - איך מסמנים</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">
                <strong style="color: #51CF66;">➡️ ימינה = ״ידעתי״.</strong>
                <span style="color: var(--text-secondary);"> אם עוד לא ראיתם את התרגום, ההחלקה הראשונה רק תחשוף אותו (בדיוק כמו לחיצה) - זה כדי שלא תסמנו ״ידעתי״ בטעות בלי לבדוק. תחליקו ימינה שוב כדי לאשר.</span>
              </div>
              <div>
                <strong style="color: #FF6B6B;">⬅️ שמאלה = ״לא ידעתי״.</strong>
                <span style="color: var(--text-secondary);"> מסמן מיד, בלי צורך לחשוף קודם. המילה תחזור אליכם שוב בהמשך אותו שיעור, לא תיעלם.</span>
              </div>
              <div style="margin-top: 0.8rem; font-size: 0.85rem; color: var(--text-secondary);">
                🔘 לא בא לכם להחליק? מתחת לכרטיס יש גם כפתורים עגולים ✓ מכיר / ✕ לא מכיר שעושים בדיוק אותו דבר.
              </div>
              <div style="margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-secondary);">
                💻 במחשב: אפשר גם עם החצים ← →, ו-Space לחשיפה.
              </div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🚦 הצבעים</h3>
            <p style="margin-bottom: 1rem; line-height: 1.8; color: var(--text-secondary);">
              כל מילה עוברת 🟥 אדום (חדשה) → 🟧 כתום (זכרתם פעם) → 🟩 ירוק (זכרתם פעמיים ברצף - שולט!). ההסבר המלא נמצא בכפתור ״מערכת הרמזור״ בתפריט הראשי.
            </p>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🛠️ כלים בכרטיס</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">📝 <strong>הוסף רמז אישי</strong> - כתבו דרך לזכור את המילה, או לחצו ״הצע לי אסוציאציה״ לקבל רעיון אוטומטי.</div>
              <div style="margin-bottom: 0.8rem;">🚩 <strong>סימון תרגום שגוי</strong> - אם תרגום נראה לא נכון, סמנו אותו כדי שנבדוק אותו.</div>
              <div style="margin-bottom: 0.8rem;">↶ <strong>ביטול</strong> - טעיתם בהחלקה? כפתור הביטול (או מקש U) מחזיר את הסימון האחרון.</div>
              <div style="margin-bottom: 0.8rem;">✅ <strong>מילים ששלטתם בהן</strong> - ברשימת ״מילים ששלטתי בהן״ בתפריט הראשי אפשר לראות את כל המילים הירוקות, ואם אחת מהן בעצם לא ידועה לכם טוב - להחזיר אותה לשינון בלחיצה אחת.</div>
              <div>🐌 <strong>מילים עקשניות</strong> - מילה שטעיתם בה הרבה פעמים (גם בשיעורים שונים) מסומנת אוטומטית כ״עקשנית״ ומוצאת זמנית מהשיעורים הרגילים, כדי שלא תעכב אתכם. אפשר לראות את הרשימה ולהחזיר מילה לשינון רגיל בכפתור ״מילים עקשניות״ בתפריט.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🧩 תרגול השלמת משפטים</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">כשיש לכם כמה מילים ירוקות (״ששלטתי בהן״), אפשר לבחור בתפריט הראשי ״תרגול השלמת משפטים״ - במקום לתרגם, מקבלים משפט באנגלית עם מילה חסרה ובוחרים את המילה הנכונה מכמה אפשרויות. זו בדיקה נוספת שאתם באמת מכירים את המילה בהקשר, לא רק זוכרים תרגום.</div>
              <div>אפשר לבחור מראש רמת קושי וכמות שאלות לסבב. בסוף הסבב מוצג סיכום עם המילים שטעיתם בהן.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">📋 עוד בתפריט הראשי</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">📋 <strong>רשימת כל המילים</strong> - כל 4,000 המילים, מסודרות לפי רמת קושי, לעיון חופשי מחוץ לשיעור.</div>
              <div style="margin-bottom: 0.8rem;">👥 <strong>חברים</strong> - למי שמחובר עם חשבון: משתפים קוד עם חבר כדי להוסיף אותו ולהשוות רצפים.</div>
              <div>📖 <strong>משאבי קריאה באנגלית</strong> - קישורים לתרגול קריאה באנגלית ברמת הפסיכומטרי.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">📅 איך ללמוד נכון</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light);">
              <div style="margin-bottom: 0.8rem;">✅ עדיף כמה שיעורים קצרים ביום מאשר שיעור ארוך אחד - זה מה שה-🔥 רצף וה-🎯 שיעורים היום בראש המסך עוקבים אחריו. אם אתם ממשיכים ברצף בלי הפסקה, האפליקציה תזכיר לכם לנוח כל כמה דקות.</div>
              <div style="margin-bottom: 0.8rem;">✅ כברירת מחדל הרמה (קל/בינוני/קשה) עולה אוטומטית - ברגע ששולטים בכל מילות הרמה הנוכחית, נפתחת הרמה הבאה. אפשר גם לבחור רמה ידנית במסך הראשי.</div>
              <div>✅ ההתקדמות נשמרת אוטומטית במכשיר, ואם תתחבר עם חשבון - גם מסתנכרנת בין מכשירים.</div>
            </div>
          </div>
        `;

        this.showModal('🧭 מדריך למתחילים', content);
      }

      isRunningStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      }

      // Auto-shows once, on mobile only (the whole concept is meaningless
      // on desktop), and never if it's already installed. Waits a beat and
      // then checks no other modal (typically the tutorial, on a brand-new
      // visit) is already open before showing - if one is, this visit is
      // skipped rather than stacking modals, and it'll try again next visit.
      maybeShowInstallPrompt() {
        if (this._installPromptChecked || this.sessionActive) return;
        this._installPromptChecked = true;
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (!isMobile || this.isRunningStandalone()) return;
        try {
          if (localStorage.getItem('psychovocab_install_prompt_seen')) return;
          setTimeout(() => {
            if (document.getElementById('modal-overlay').style.display === 'flex') return;
            localStorage.setItem('psychovocab_install_prompt_seen', '1');
            this.showInstallPromptModal();
          }, 4000);
        } catch (e) {
          // localStorage unavailable - just skip the auto-popup.
        }
      }

      showInstallPromptModal() {
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) && !window.MSStream;

        if (isIOS) {
          const content = `
            <div style="text-align: center;">
              <div style="font-size: 2.5rem; margin-bottom: 1rem;">📲</div>
              <p style="margin-bottom: 1.5rem; line-height: 1.8;">
                אפשר להוסיף את PsychoVocab למסך הבית שלך, ולפתוח אותה כמו אפליקציה רגילה - בלי הדפדפן מסביב.
              </p>
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; text-align: right; line-height: 2;">
                <div>1️⃣ לחצו על כפתור השיתוף <strong>􀈂</strong> בסרגל הכלים למטה</div>
                <div>2️⃣ גללו ובחרו <strong>״הוסף למסך הבית״</strong></div>
                <div>3️⃣ לחצו <strong>״הוסף״</strong> למעלה</div>
              </div>
            </div>
          `;
          this.showModal('📲 הוסיפו למסך הבית', content);
          return;
        }

        if (deferredInstallPrompt) {
          const content = `
            <div style="text-align: center;">
              <div style="font-size: 2.5rem; margin-bottom: 1rem;">📲</div>
              <p style="margin-bottom: 1.5rem; line-height: 1.8;">
                אפשר להתקין את PsychoVocab למסך הבית שלך, ולפתוח אותה כמו אפליקציה רגילה - בלי הדפדפן מסביב.
              </p>
              <button class="btn btn-primary" onclick="app.triggerNativeInstall()" style="width: 100%;">
                📲 התקן עכשיו
              </button>
            </div>
          `;
          this.showModal('📲 התקינו את PsychoVocab', content);
          return;
        }

        const content = `
          <div style="text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">📲</div>
            <p style="line-height: 1.8;">
              אפשר להוסיף את PsychoVocab למסך הבית מתוך תפריט הדפדפן (בדרך כלל שלוש נקודות למעלה) - חפשו ״הוסף למסך הבית״ או ״התקן אפליקציה״.
            </p>
          </div>
        `;
        this.showModal('📲 הוסיפו למסך הבית', content);
      }

      triggerNativeInstall() {
        this.closeModal();
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.finally(() => {
          deferredInstallPrompt = null;
        });
      }

      renderLoadingScreen(appContent) {
        appContent.innerHTML = `
          <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem;">
            <div style="text-align: center;">
              <div style="font-size: 2.5rem; margin-bottom: 1rem;">📚</div>
              <div style="width: 28px; height: 28px; margin: 0 auto; border: 3px solid var(--border-light); border-top-color: var(--sage-green); border-radius: 50%; animation: app-boot-spin 0.8s linear infinite;"></div>
            </div>
          </div>
          <style>@keyframes app-boot-spin { to { transform: rotate(360deg); } }</style>
        `;
      }

      renderLoginScreen(appContent) {
        let html = `
          <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem;">
            <div style="background: var(--bg-card); border-radius: 2px; padding: 2.5rem 2rem; border: 1px solid var(--border-light); border-top: 3px solid var(--gold-accent); max-width: 400px; width: 100%;">
              <div style="text-align: center; margin-bottom: 2rem;">
                <div style="font-size: 2.5rem; margin-bottom: 1rem;">📚</div>
                <h1 style="font-family: var(--font-display); font-size: 2.3rem; font-weight: 500; letter-spacing: 0.5px; color: var(--dark-navy); margin: 0 0 0.5rem;">PsychoVocab</h1>
                <p style="color: var(--text-secondary); margin: 0;">הכנה פסיכומטרית עם שמירת התקדמות</p>
              </div>
              
              <div id="auth-form-container">
                <!-- Login Form -->
                <div id="login-form" style="display: block;">
                  <h2 style="font-size: 1.3rem; color: var(--dark-navy); margin-bottom: 1.5rem; text-align: center;">כניסה</h2>
                  
                  <div style="margin-bottom: 1rem;">
                    <label for="login-email" style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">דוא"ל</label>
                    <input type="email" id="login-email" autocomplete="email" placeholder="your@email.com" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>

                  <div style="margin-bottom: 1.5rem;">
                    <label for="login-password" style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">סיסמה</label>
                    <input type="password" id="login-password" autocomplete="current-password" placeholder="••••••••" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>
                  
                  <div id="login-error" style="color: var(--red); margin-bottom: 1rem; font-size: 0.9rem; display: none;"></div>

                  <button onclick="app.handleLogin()" style="width: 100%; padding: 0.75rem; background: var(--sage-green); color: white; border: none; border-radius: 2px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-bottom: 1rem;">
                    כניסה
                  </button>

                  <p style="text-align: center; color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 0.5rem;">
                    <a href="#" onclick="app.handleForgotPassword(event)" style="color: var(--teal); text-decoration: none; font-weight: 500;">שכחת סיסמה?</a>
                  </p>

                  <p style="text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                    אין לך חשבון? <a href="#" onclick="app.toggleAuthForm(event)" style="color: var(--teal); text-decoration: none; font-weight: 500;">הרשמה</a>
                  </p>
                </div>
                
                <!-- Register Form -->
                <div id="register-form" style="display: none;">
                  <h2 style="font-size: 1.3rem; color: var(--dark-navy); margin-bottom: 1.5rem; text-align: center;">הרשמה</h2>
                  
                  <div style="margin-bottom: 1rem;">
                    <label for="register-email" style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">דוא"ל</label>
                    <input type="email" id="register-email" autocomplete="email" placeholder="your@email.com" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>

                  <div style="margin-bottom: 1rem;">
                    <label for="register-password" style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">סיסמה (לפחות 6 תווים)</label>
                    <input type="password" id="register-password" autocomplete="new-password" placeholder="••••••••" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>
                  
                  <div id="register-error" style="color: var(--red); margin-bottom: 1rem; font-size: 0.9rem; display: none;"></div>
                  
                  <button onclick="app.handleRegister()" style="width: 100%; padding: 0.75rem; background: var(--sage-green); color: white; border: none; border-radius: 2px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-bottom: 1rem;">
                    הרשמה
                  </button>
                  
                  <p style="text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                    יש לך כבר חשבון? <a href="#" onclick="app.toggleAuthForm(event)" style="color: var(--teal); text-decoration: none; font-weight: 500;">כניסה</a>
                  </p>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: 0.75rem; margin: 1.5rem 0; color: var(--text-secondary); font-size: 0.85rem;">
                <div style="flex: 1; border-top: 1px solid var(--border-light);"></div>
                או
                <div style="flex: 1; border-top: 1px solid var(--border-light);"></div>
              </div>

              <button onclick="app.handleGoogleSignIn()" style="width: 100%; padding: 0.7rem; background: white; color: var(--text-primary); border: 1px solid var(--border-light); border-radius: 2px; font-size: 0.95rem; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.6rem;">
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 009 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 013.68 9c0-.59.1-1.16.27-1.7V4.97H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
                המשך עם Google
              </button>

              <div id="google-signin-error" style="color: var(--red); margin-top: 0.75rem; font-size: 0.9rem; display: none; text-align: center;"></div>

              <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border-light); font-size: 0.85rem; color: var(--text-secondary); text-align: center;">
                <button onclick="app.continueWithoutLogin()" style="color: var(--teal); background: none; border: none; cursor: pointer; text-decoration: underline;">המשך ללא כניסה</button>
              </div>
            </div>
          </div>
        `;

        appContent.innerHTML = html;
      }

      handleGoogleSignIn() {
        signInWithGoogle()
          .then(() => {
            this.render();
          })
          .catch((error) => {
            const errorEl = document.getElementById('google-signin-error');
            if (errorEl) {
              errorEl.textContent = 'שגיאה בכניסה עם Google: ' + error;
              errorEl.style.display = 'block';
            }
          });
      }

      toggleAuthForm(e) {
        e.preventDefault();
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');
        
        if (loginForm.style.display === 'block') {
          loginForm.style.display = 'none';
          registerForm.style.display = 'block';
        } else {
          loginForm.style.display = 'block';
          registerForm.style.display = 'none';
        }
      }
      
      handleLogin() {
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');
        
        if (!email || !password) {
          errorEl.textContent = 'אנא מלא את כל השדות';
          errorEl.style.display = 'block';
          return;
        }
        
        loginUser(email, password)
          .then(() => {
            this.render();
          })
          .catch((error) => {
            errorEl.textContent = 'שגיאה בכניסה: ' + error;
            errorEl.style.display = 'block';
          });
      }

      handleForgotPassword(e) {
        e.preventDefault();
        const errorEl = document.getElementById('login-error');
        const email = document.getElementById('login-email').value;

        if (!email) {
          errorEl.style.color = 'var(--red)';
          errorEl.textContent = 'הזן קודם את כתובת הדוא"ל שלך בשדה למעלה';
          errorEl.style.display = 'block';
          return;
        }

        resetPassword(email)
          .then(() => {
            errorEl.style.color = 'var(--sage-green)';
            errorEl.textContent = 'נשלח מייל לאיפוס סיסמה ל-' + email;
            errorEl.style.display = 'block';
          })
          .catch((error) => {
            errorEl.style.color = 'var(--red)';
            errorEl.textContent = 'שגיאה בשליחת מייל איפוס: ' + error;
            errorEl.style.display = 'block';
          });
      }

      handleRegister() {
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const errorEl = document.getElementById('register-error');
        
        if (!email || !password) {
          errorEl.textContent = 'אנא מלא את כל השדות';
          errorEl.style.display = 'block';
          return;
        }
        
        if (password.length < 6) {
          errorEl.textContent = 'הסיסמה חייבת להיות לפחות 6 תווים';
          errorEl.style.display = 'block';
          return;
        }
        
        registerUser(email, password)
          .then(() => {
            this.render();
          })
          .catch((error) => {
            errorEl.textContent = 'שגיאה בהרשמה: ' + error;
            errorEl.style.display = 'block';
          });
      }
      
      continueWithoutLogin() {
        // Allow users to continue without Firebase/login
        this.userSkippedLogin = true;
        this.render();
      }
      
      logout() {
        this.userSkippedLogin = false; // Reset so login screen shows again
        logoutUser()
          .then(() => {
            // Wipe this device's local copy of the outgoing account's
            // progress. saveState() writes every autosave to this same
            // shared localStorage key regardless of login state, so
            // leaving it in place would hand this account's words/streak/
            // history to whoever uses this browser next as a guest or a
            // brand-new account - loadProgressFromFirebase() falls back to
            // local storage whenever the new account has no cloud snapshot
            // yet (e.g. a fresh registration), silently attributing it to
            // them and then syncing it into their Firebase account on the
            // next save.
            localStorage.removeItem(STORAGE_KEY);
            this.words = this.initializeWords();
            this.allTimeStats = { totalAttempts: 0, totalCorrect: 0 };
            this.currentStreak = 0;
            this.sessionsToday = 0;
            this.lastStudyDate = null;
            this.studyHistory = {};
            this.difficultyOverride = null;
            this.sessionActive = false;
            this.currentSession = [];
            this.sessionIndex = 0;
            this.sessionStats = { correct: 0, incorrect: 0, streak: 0 };
            this.render();
          })
          .catch((error) => {
            console.error('Logout error:', error);
          });
      }
      
      renderStartScreen(appContent, stats) {
        const allMastered = stats.remaining === 0;

        let html = `
          <div class="start-screen">
            <div class="start-title">מוכן לשנן?</div>
            <div class="start-description">
              שולט על מילים באנגלית לבחינת הפסיכומטרי.<br>
              התקדמות כללית: <strong>${stats.mastered}/${this.words.length}</strong> מילים שולט<br>
              ${stats.remaining > 0
                ? `יש לך <strong>${stats.remaining}</strong> מילים נותרים לשלוט.`
                : `ברכות! שלטת בכל ${this.words.length.toLocaleString('he-IL')} המילים! 🎉`
              }
            </div>
        `;

        // Nudges a learner back when words they answered correctly once
        // have finished resting and are ready for the confirmation round
        // that turns them green - purely informational (no "streak at
        // risk" framing), since the whole point of the rest period only
        // pays off if the learner actually comes back for round two.
        const now = Date.now();
        const readyCount = this.words.filter(w => w.status === 'orange' && w.dueAt && w.dueAt <= now && !w.leech).length;
        if (readyCount > 0 && !this.sessionActive) {
          html += `
            <div style="background: var(--light-sage); border: 1px solid rgba(74, 122, 90, 0.25); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem; text-align: center;">
              🔔 <strong>${readyCount}</strong> מילים סיימו לנוח ומוכנות לאישור סופי - זה הזמן הכי טוב לחזור אליהן.
            </div>
          `;
        }


        // Current-tier banner: shows where the learner stands within the
        // current tier, plus a picker letting them pin a specific tier
        // instead of the default automatic easy->moderate->hard
        // progression (see getCurrentTier()/setDifficultyOverride()).
        const tierLabels = { easy: '🟢 קל', moderate: '🟡 בינוני', hard: '🔴 קשה' };
        const currentTier = this.getCurrentTier();
        const currentTierWords = this.words.filter(w => w.difficulty === currentTier);
        const currentTierMastered = currentTierWords.filter(w => w.status === 'green').length;
        const isAuto = !this.difficultyOverride;

        html += `
          <div style="background: var(--bg-light); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem; border: 1px solid var(--border-light); text-align: center;">
            <div style="font-weight: 600; margin-bottom: 0.5rem; color: var(--sage-green);">
              📍 הרמה הנוכחית שלך
            </div>
            <div style="font-size: 1.4rem; font-weight: 700; margin-bottom: 0.4rem;">
              ${tierLabels[currentTier]}
            </div>
            <div style="font-size: 0.9rem; color: var(--text-secondary);">
              ${currentTierMastered.toLocaleString()}/${currentTierWords.length.toLocaleString()} מילים ברמה זו שולטו
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.6rem;">
              ${isAuto
                ? 'הרמה מתקדמת אוטומטית - ברגע ששולטים בכל המילים ברמה הנוכחית, נפתחת הרמה הבאה.'
                : 'קבעת רמה ידנית - היא לא תתקדם אוטומטית עד שתעבור בחזרה למצב אוטומטי.'}
            </div>
            <div style="margin-top: 1rem; display: flex; flex-direction: column; align-items: center;">
              <label style="font-size: 0.85rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">
                בחירת רמה
              </label>
              <div class="tier-segmented" role="group" aria-label="בחירת רמה">
                ${[
                  { value: 'auto', label: '🤖 אוטומטי', active: isAuto },
                  { value: 'easy', label: '🟢 קל', active: this.difficultyOverride === 'easy' },
                  { value: 'moderate', label: '🟡 בינוני', active: this.difficultyOverride === 'moderate' },
                  { value: 'hard', label: '🔴 קשה', active: this.difficultyOverride === 'hard' }
                ].map(t => `
                  <button type="button" class="tier-segment-btn${t.active ? ' active' : ''}" onclick="app.setDifficultyOverride('${t.value}')">
                    ${t.label}
                  </button>
                `).join('')}
              </div>
            </div>
          </div>
        `;
        
        
        if (stats.remaining > 0) {
          html += `
            <button class="btn btn-primary" onclick="app.startNewSession()" style="font-size: 1.1rem; padding: 1rem 2.5rem;">
              התחל שינון
            </button>
          `;
        } else {
          html += `
            <button class="btn btn-primary" onclick="app.resetAllData()" style="font-size: 1.1rem; padding: 1rem 2.5rem;">
              איפוס והתחלה מחדש
            </button>
          `;
        }
        
        html += `
          <div class="save-controls" style="display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center;">
            <button class="btn btn-secondary" onclick="app.showTutorialModal()">
              🧭 מדריך למתחילים
            </button>
            <button class="btn btn-secondary" onclick="app.showHelpModal()">
              ℹ️ מערכת הרמזור - איך זה עובד?
            </button>
            <button class="btn btn-secondary" onclick="app.shareApp()">
              📤 שתף עם חבר
            </button>
            ${!this.isRunningStandalone() ? `
              <button class="btn btn-secondary" onclick="app.showInstallPromptModal()">
                📲 הוסף למסך הבית
              </button>
            ` : ''}
          </div>
        `;
        
        html += `
          <div class="traffic-light-legend">
            <h3>🚦 מערכת הרמזור</h3>
            
            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              כל מילה עוברת סבב חזרה עולה עד שהיא נשלטת לחלוטין לטווח ארוך. בכל שיעור אתם רואים מילים אקראיות מכל השלבים. המטרה היא להגיע לשלב הירוק (✅ שלוט) עבור כל המילים!
            </p>

            <div class="legend-item">
              <div class="legend-dot" style="background: var(--red);"></div>
              <span><strong>🟥 אדום (חדש):</strong> המילה חדשה או קיבלת אותה בטעות. חזור לתחילה!</span>
            </div>

            <div class="legend-item">
              <div class="legend-dot" style="background: var(--orange);"></div>
              <span><strong>🟧 כתום (בתהליך):</strong> זכרתם את המילה נכון לפחות פעם אחת. עוד סבבים מרווחים והולכים - ואתם בדרך לירוק!</span>
            </div>

            <div class="legend-item">
              <div class="legend-dot" style="background: var(--green);"></div>
              <span><strong>🟩 ירוק (שלוט):</strong> שרדתם ארבעה סבבי חזרה עולים ברצף. המילה נשלטת לטווח ארוך!</span>
            </div>

            <h3 style="margin-top: 2rem;">🔄 מערכת החזרה המרווחת (Spaced Repetition)</h3>

            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              אנחנו משתמשים במערכת מתמטית שהוכחה שמשפרת את הזיכרון לטווח ארוך: כל תשובה נכונה מרחיקה את הבדיקה הבאה על אותה מילה, כדי לוודא שהיא באמת שרדה במעבר הזמן ולא רק נשמרה לרגע:
            </p>

            <div style="background: var(--bg-card-hover); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 1 (אדום - חדש):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  למדתם את המילה בפעם הראשונה. תראו אותה שוב בעוד 4 שעות.
                </p>
              </div>

              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 2 (כתום):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת אותה! עכשיו תראה אותה שוב בעוד יום.
                </p>
              </div>

              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 3 (כתום):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת שוב! עכשיו תראה אותה שוב בעוד 3 ימים.
                </p>
              </div>

              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 4 (כתום):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת שוב! עכשיו תראה אותה שוב בעוד שבוע - הבדיקה האחרונה.
                </p>
              </div>

              <div>
                <strong>📍 שלב 5 (ירוק - שולט):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת אותה גם אחרי שבוע שלם! המילה הוסרה מהתור הרגיל - היא באמת נחרתה בזיכרון.
                </p>
              </div>
            </div>

            <p style="margin-bottom: 1.5rem; line-height: 1.8; color: var(--text-secondary); font-size: 0.95rem;">
              טעות באמצע הסבב? המילה חוזרת ישר לאדום ומתחילה מחדש מהשלב הראשון - כדי שהירוק תמיד יבטא שליטה אמיתית, לא ניחוש חד-פעמי.
            </p>

            <h3 style="margin-top: 2rem;">⏰ לוח זמנים לדוגמה</h3>

            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              <strong>דוגמה תיאורטית ללמידת מילה חדשה:</strong>
            </p>

            <div style="background: var(--bg-card-hover); padding: 1.5rem; border-radius: 2px;">
              <div style="display: grid; gap: 1rem;">
                <div>
                  <strong style="color: var(--teal);">היום, 09:00:</strong> למדת מילה חדשה "Ambitious" → 🟥 אדום
                </div>
                <div>
                  <strong style="color: var(--teal);">היום, 13:00 (עוד 4 שעות):</strong> ענית נכון → 🟧 כתום, הבדיקה הבאה בעוד יום
                </div>
                <div>
                  <strong style="color: var(--teal);">מחר:</strong> ענית נכון → 🟧 כתום, הבדיקה הבאה בעוד 3 ימים
                </div>
                <div>
                  <strong style="color: var(--teal);">בעוד 4 ימים:</strong> ענית נכון → 🟧 כתום, הבדיקה הבאה בעוד שבוע
                </div>
                <div>
                  <strong style="color: var(--teal);">בעוד כשבוע וחצי:</strong> ענית נכון בפעם החמישית → 🟩 ירוק (שולט לטווח ארוך!)
                </div>
              </div>
            </div>

            <h3 style="margin-top: 2rem;">💡 טיפים לשלמות</h3>

            <div style="background: var(--bg-card-hover); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <ul style="list-style: none; padding: 0;">
                <li style="margin-bottom: 1rem;">✅ <strong>עשה שיעורים מרובים ביום:</strong> תחזק את הזיכרון שלך</li>
                <li style="margin-bottom: 1rem;">✅ <strong>הוסף קשרים אישיים:</strong> לחץ על 📝 להוסיף זיכרון עזר</li>
                <li style="margin-bottom: 1rem;">✅ <strong>אל תדלג על ימים:</strong> כדי לשמור על הזיכרון חוזר בעל יעילות</li>
                <li>✅ <strong>תרכיז על מילים אדומות:</strong> אלו החדשות שצריך להיזכר בהן</li>
              </ul>
            </div>
          </div>

          <div class="mastery-section">
            <div class="mastery-title">🎯 כלל השולט</div>
            <div class="mastery-description">
              בקצרה: מילה נשלטת רק אחרי שאתם מצליחים לזכור אותה נכון <strong>בארבעה סבבי חזרה עולים ברצף (4 שעות, יום, 3 ימים, שבוע)</strong> - ואז היא יורדת מהתור הפעיל. טעות באמצע מחזירה אותה לתחילת הדרך.
            </div>
          </div>
          
          <!-- Reading Timer Section at Bottom -->
          <div class="timer-container" style="margin-top: 3rem; opacity: 0.8; border-top: 1px solid var(--border-light); padding-top: 2rem;">
            <div class="timer-title">📚 זמן קריאה מומלץ</div>
            <div class="timer-subtitle">קרא מספרים באנגלית 30-60 דקות ביום או בחר זמן אחר</div>
            
            ${this.readingTimerActive || this.readingTimerPaused ? `
              <!-- Active Timer Display -->
              <div class="timer-display">
                <div class="timer-circle ${this.readingTimerActive ? 'active' : ''}">
                  <div>
                    <div class="timer-time" id="reading-timer-display">
                      ${this.formatTime(this.readingTimeRemaining)}
                    </div>
                    <div class="timer-label">
                      ${this.readingTimerPaused ? '⏸ השהוי' : '⏱ זמן נתור'}
                    </div>
                  </div>
                </div>
              </div>
              
              <!-- Progress Bar -->
              <div class="timer-progress">
                <div class="timer-progress-bar" id="reading-timer-progress" style="width: ${(this.readingTimeRemaining / this.readingTimeTotal) * 100}%"></div>
              </div>
              
              <!-- Timer Controls -->
              <div class="timer-controls">
                ${this.readingTimerActive ? `
                  <button class="timer-button pause" onclick="app.pauseReadingTimer()">
                    ⏸ השהה
                  </button>
                  <button class="timer-button stop" onclick="app.stopReadingTimer()">
                    ⛔ עצור
                  </button>
                ` : `
                  <button class="timer-button resume" onclick="app.resumeReadingTimer()">
                    ▶ המשך
                  </button>
                  <button class="timer-button stop" onclick="app.stopReadingTimer()">
                    ⛔ עצור
                  </button>
                `}
              </div>
            ` : `
              <!-- Timer Presets -->
              <div class="timer-presets">
                <button class="timer-preset" onclick="app.startReadingTimer(30)">
                  ⏱<br>30 דקות
                </button>
                <button class="timer-preset" onclick="app.startReadingTimer(60)">
                  ⏱<br>60 דקות
                </button>
              </div>
              
              <!-- Custom Timer Input -->
              <div style="margin-top: 1rem; display: flex; gap: 0.8rem;">
                <input type="number" id="custom-timer-input" placeholder="הכנס דקות" min="1" max="180" style="flex: 1; padding: 0.75rem; border: 2px solid var(--border-light); border-radius: 2px; font-size: 1rem; text-align: center; direction: rtl;" />
                <button class="btn btn-primary" onclick="app.startCustomTimer()" style="padding: 0.75rem 1.5rem;">
                  התחל
                </button>
              </div>
            `}
            
            <!-- Resources Button -->
            <button class="btn btn-primary" onclick="app.showReadingResources()" style="width: 100%; margin-top: 1rem;">
              📖 משאבי קריאה באנגלית
            </button>

            <button class="btn btn-secondary" onclick="app.showProgressModal()" style="width: 100%; margin-top: 0.75rem;">
              📈 ההתקדמות שלי
            </button>

            <button class="btn btn-secondary" onclick="app.showFriendsModal()" style="width: 100%; margin-top: 0.75rem;">
              👥 חברים
            </button>

            <button class="btn btn-secondary" onclick="app.showFeedbackModal()" style="width: 100%; margin-top: 0.75rem;">
              💌 משוב ויצירת קשר
            </button>

            <div style="text-align: center; margin-top: 1.5rem;">
              <img src="assets/logo.png" alt="Logo" style="width: 100px; height: auto; display: inline-block;">
            </div>

            <button class="btn btn-secondary" onclick="app.showFlaggedWordsModal()" style="width: 100%; margin-top: 0.75rem;">
              🚩 מילים שסימנתי${this.words.filter(w => w.flagged).length > 0 ? ` (${this.words.filter(w => w.flagged).length})` : ''}
            </button>

            <button class="btn btn-secondary" onclick="app.showLeechWordsModal()" style="width: 100%; margin-top: 0.75rem;">
              🐌 מילים עקשניות${this.words.filter(w => w.leech).length > 0 ? ` (${this.words.filter(w => w.leech).length})` : ''}
            </button>

            <button class="btn btn-secondary" onclick="app.showMasteredWordsModal()" style="width: 100%; margin-top: 0.75rem;">
              ✅ מילים ששלטתי בהן${this.words.filter(w => w.status === 'green').length > 0 ? ` (${this.words.filter(w => w.status === 'green').length})` : ''}
            </button>

            <button class="btn btn-secondary" onclick="app.startSentenceGame()" style="width: 100%; margin-top: 0.75rem;">
              🧩 תרגול השלמת משפטים - בוחן על מילים ששלטתי בהן
            </button>

            <button class="btn btn-secondary" onclick="app.showFullWordListModal()" style="width: 100%; margin-top: 0.75rem;">
              📋 רשימת כל המילים (${this.words.length.toLocaleString()})
            </button>

            ${currentUser ? `
              <div style="margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--border-light);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                  <div style="display: flex; align-items: center; gap: 0.75rem;">
                    ${currentUser.photoURL && /^https:\/\//.test(currentUser.photoURL)
                      ? `<img src="${app.escapeHtml(currentUser.photoURL)}" alt="" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">`
                      : `<div style="width: 40px; height: 40px; border-radius: 50%; background: var(--sage-green); color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1rem; flex-shrink: 0;">${app.escapeHtml((currentUser.displayName || currentUser.email || '?').charAt(0).toUpperCase())}</div>`
                    }
                    <div>
                      <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 0.2rem;">ברוך הבא</p>
                      <p style="font-size: 1rem; font-weight: 600; color: var(--dark-navy); margin: 0;">${app.escapeHtml(currentUser.displayName || currentUser.email)}</p>
                    </div>
                  </div>
                  <button onclick="app.logout()" style="padding: 0.5rem 1.25rem; background: var(--red); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 500;">
                    ↗ יציאה
                  </button>
                </div>
                ${currentUser.email === 'eilaydror@gmail.com' ? `
                  <button class="btn btn-secondary" onclick="app.showWordReportsModal()" style="width: 100%; margin-top: 0.75rem;">
                    🛠️ דוחות מילים מכל המשתמשים
                  </button>
                ` : ''}
              </div>
            ` : `
              <div style="margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--border-light); text-align: center;">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0 0 0.75rem;">
                  אתם משננים במצב אורח - ההתקדמות נשמרת רק במכשיר הזה.
                </p>
                <button class="btn btn-primary" onclick="app.showLoginScreen()" style="width: 100%;">
                  🔐 התחבר / הירשם כדי לשמור בענן
                </button>
              </div>
            `}
          </div>
        `;

        appContent.innerHTML = html;
      }

      showLoginScreen() {
        // Lets a guest ("המשך ללא כניסה") come back to the login/register
        // gate later - the account section of the main menu has no other
        // path back to it, see getScreenType(). Doesn't touch any saved
        // data: a fresh registration finds no existing cloud snapshot and
        // falls back to the local progress already in localStorage (see
        // loadProgressFromFirebase), and a login to an existing account
        // merges by per-word updatedAt, so nothing here is destructive.
        this.userSkippedLogin = false;
        this.render();
      }

      renderSession(appContent) {
        // Filter out mastered words (status = 'green') and words now
        // resting after a correct first answer (real spaced repetition -
        // see markWordKnown/startNewSession).
        const now = Date.now();
        const activeWords = this.currentSession.filter(w =>
          w.status !== 'green' && (w.status === 'red' || !w.dueAt || w.dueAt <= now)
        );

        if (activeWords.length === 0) {
          this.renderSessionEnd(appContent);
          return;
        }

        const masteredCount = this.currentSession.filter(w => w.status === 'green').length;
        // One word at a time, not a busy grid - less to scan, no ambiguity
        // about which card keyboard/swipe actions apply to.
        const word = activeWords[0];

        // Only reset the "has the learner actually seen the translation"
        // flag when a genuinely new word comes on screen - a re-render of
        // the same card (e.g. toggling the flag) shouldn't wipe it out.
        const isNewWord = this._lastRenderedWordId !== word.id;
        if (isNewWord) {
          this._revealed = false;
          this._revealedForWordId = word.id;
        }
        this._lastRenderedWordId = word.id;

        // Only a genuinely new card sliding in right after a grade should
        // continue that grade's direction - re-renders of the same word
        // (toggling the flag, editing a note) or jumping to a different
        // word from the sidebar get the plain fade-up entrance instead.
        const enterClass = (isNewWord && this._lastGradeDir === 1) ? 'enter-right'
          : (isNewWord && this._lastGradeDir === -1) ? 'enter-left' : '';
        if (isNewWord) this._lastGradeDir = null;

        // Side list of the whole set currently in play, one row per word,
        // color-coded by the same red/orange/green status shown everywhere
        // else - lets the learner see at a glance what's left before this
        // set is done. Rebuilt on every render() call, so it updates live
        // the moment a word's status changes (see markWordKnown/Unknown).
        // Only words currently "active" (due now, not yet mastered) can be
        // jumped to - clicking a resting/mastered word wouldn't have
        // anything sensible to show, since renderSession would just filter
        // it back out again.
        const activeIds = new Set(activeWords.map(w => w.id));
        const sideListHtml = this.currentSession.map(w => {
          const isCurrent = w.id === word.id;
          const isClickable = !isCurrent && activeIds.has(w.id);
          return `
          <li class="session-word-item ${isCurrent ? 'active' : ''} ${isClickable ? 'clickable' : ''}"
              ${isClickable ? `onclick="app.jumpToWord(${w.id})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.jumpToWord(${w.id})}"` : ''}>
            <span class="status-dot ${w.status || 'red'}" aria-label="${w.status === 'green' ? 'שולט' : w.status === 'orange' ? 'בתהליך' : 'טרם נלמד'}" title="${w.status === 'green' ? 'שולט' : w.status === 'orange' ? 'בתהליך' : 'טרם נלמד'}"></span>
            <span>${this.escapeHtml(w.english)}</span>
          </li>
        `;
        }).join('');

        let html = `
          <div class="session-container">
            <div class="session-layout">
              <div class="session-main">
            <div style="text-align: center; margin-bottom: 1.5rem;">
              <div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                התקדמות: ${masteredCount}/${this.currentSession.length} מילים שולט
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${(masteredCount / this.currentSession.length) * 100}%"></div>
              </div>
            </div>

            <div class="word-card swipe-area ${enterClass}" id="current-word-card">
              <div class="english-word-row">
                <span class="english-word">${this.escapeHtml(word.english)}</span>
                <button type="button" class="speak-btn" data-word="${this.escapeHtml(word.english)}" onclick="event.stopPropagation(); app.speakWord(this)" aria-label="השמע הגייה" title="השמע הגייה">🔊</button>
              </div>
              <div class="hebrew-translation hidden" id="hebrew-word">${this.escapeHtml(word.hebrew)}</div>
              <div class="example-sentence hidden" id="example-sentence">${this.escapeHtml(word.example || '')}</div>
              <div id="toggle-hint" style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.5rem;">לחץ לגילוי התרגום</div>
              <button onclick="event.stopPropagation(); app.toggleNoteField(${word.id})" style="margin-top: 1.5rem; background: none; border: none; color: var(--sage-green); cursor: pointer; font-size: 0.85rem; text-decoration: underline;">
                📝 ${word.association ? 'ערוך רמז אישי' : 'הוסף רמז אישי - אסוציאציה מומלצת'}
              </button>
              <div id="note-field-wrapper" style="display: none; margin-top: 1rem;" onclick="event.stopPropagation()">
                <button onclick="app.suggestAssociation(${word.id})" type="button" style="margin-bottom: 0.6rem; background: var(--light-sage); border: 1px solid rgba(74, 122, 90, 0.25); color: var(--sage-green); cursor: pointer; font-size: 0.8rem; padding: 0.5rem 0.9rem; border-radius: 10px; font-weight: 500;">
                  💡 הצע לי אסוציאציה
                </button>
                <textarea id="assoc-${word.id}" placeholder="💭 כתוב דרך להיזכר, או לחץ למעלה לקבלת הצעה..." style="width: 100%; padding: 0.6rem; font-size: 0.85rem; direction: rtl; border: 1px solid var(--border-light); border-radius: 10px; min-height: 60px;" onchange="window.app.updateAssociation(${word.id}, this.value)">${this.escapeHtml(word.association || '')}</textarea>
              </div>
              <div>
                <button onclick="event.stopPropagation(); app.toggleFlag(${word.id})" style="margin-top: 0.75rem; background: none; border: none; color: ${word.flagged ? 'var(--red)' : 'var(--text-secondary)'}; cursor: pointer; font-size: 0.8rem;">
                  🚩 ${word.flagged ? 'סומן לבדיקה - לחץ לביטול' : 'התרגום לא נראה נכון?'}
                </button>
              </div>
            </div>

            <div class="swipe-hint">
              <div class="swipe-direction incorrect"><span class="arrow">←</span> תחליקו שמאלה - לא יודע</div>
              <div class="swipe-direction correct">תחליקו ימינה - יודע <span class="arrow">→</span></div>
            </div>

            <div class="grade-buttons">
              <button class="grade-circle-btn dont-know" onclick="this.blur(); app.gradeCurrentCard(app.getCurrentSessionWord(), false)">
                <span class="grade-circle">✕</span>
                <span class="grade-label">לא מכיר</span>
              </button>
              <button class="grade-circle-btn know" onclick="this.blur(); app.attemptGradeKnown(app.getCurrentSessionWord())">
                <span class="grade-circle">✓</span>
                <span class="grade-label">מכיר</span>
              </button>
            </div>

            <div style="text-align: center; margin-top: 0.85rem;">
              <button class="btn btn-sm btn-secondary master-word-btn" onclick="app.masterWordNow(app.getCurrentSessionWord())">
                ✓✓ כבר יודע/ת מצוין - שינון עד תום
              </button>
            </div>

            <div style="text-align: center; margin-top: 1.5rem;">
              <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 1rem;">
                Space לגילוי &nbsp;·&nbsp; U ביטול &nbsp;·&nbsp; B חזור לתפריט
              </div>
              <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
                <button onclick="app.undo()" class="btn btn-secondary">
                  ↶ ביטול (<strong>U</strong>)
                </button>
                <button onclick="app.goBack()" class="btn" style="color: var(--red); border-color: var(--red);">
                  ← חזור לתפריט (<strong>B</strong>)
                </button>
              </div>
            </div>
              </div>

              <aside class="session-sidebar">
                <details class="session-word-list" open>
                  <summary>המילים בסבב הנוכחי (${this.currentSession.length})</summary>
                  <ul class="session-word-list-items">
                    ${sideListHtml}
                  </ul>
                </details>
              </aside>
            </div>
          </div>
        `;

        appContent.innerHTML = html;

        const cardEl = document.getElementById('current-word-card');
        if (cardEl) {
          cardEl.addEventListener('click', () => {
            if (this._justSwiped) { this._justSwiped = false; return; }
            this.toggleTranslation();
          });
          this.setupCardSwipeDetection(cardEl, word);
        }
      }

      toggleNoteField(wordId) {
        const wrapper = document.getElementById('note-field-wrapper');
        if (!wrapper) return;
        const isHidden = wrapper.style.display === 'none';
        wrapper.style.display = isHidden ? 'block' : 'none';
        if (isHidden) {
          const textarea = document.getElementById('assoc-' + wordId);
          if (textarea) setTimeout(() => textarea.focus(), 0);
        }
      }

      toggleFlag(wordId) {
        // Lets a user mark a word whose translation looks wrong/off, so it
        // can be reviewed and fixed later - this is a v1 word list, some
        // entries are bound to need a second look.
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;
        word.flagged = !word.flagged;
        word.updatedAt = Date.now();
        this.saveProgress();
        this.syncFlagReport(word);
        this.render();
      }

      // Flags are otherwise private to each user's own progress node (by
      // design - see the RTDB rules). Without this, whoever flags a word
      // on their own device is invisible to everyone else, including the
      // person who actually needs to fix the word list. This writes a
      // second, tiny record to a shared location only the app owner can
      // read (see wordReports rule), so real reports don't get lost.
      syncFlagReport(word) {
        if (!firebaseReady || !currentUser) return;
        const ref = db.ref(`wordReports/${word.id}/${currentUser.uid}`);
        if (word.flagged) {
          ref.set({
            english: word.english,
            hebrew: word.hebrew,
            reportedAt: firebase.database.ServerValue.TIMESTAMP
          }).catch((error) => {
            console.warn('Could not sync flag report:', error.message);
          });
        } else {
          ref.remove().catch(() => {});
        }
      }

      // Admin-only view (gated both in the UI, below, and by the RTDB
      // read rule itself) listing every word flagged by any user, most
      // widely-reported first.
      showWordReportsModal() {
        if (!firebaseReady || !currentUser) {
          this.showModal('🛠️ דוחות מילים', '<p style="text-align: center; color: var(--text-secondary);">צריך להתחבר כדי לראות דוחות.</p>');
          return;
        }
        db.ref('wordReports').once('value').then((snap) => {
          const data = snap.val() || {};
          const rows = Object.entries(data).map(([wordId, reports]) => {
            const sample = Object.values(reports)[0];
            return { wordId, english: sample.english, hebrew: sample.hebrew, reporterCount: Object.keys(reports).length };
          }).sort((a, b) => b.reporterCount - a.reporterCount);

          let content;
          if (rows.length === 0) {
            content = '<p style="text-align: center; color: var(--text-secondary);">אין עדיין דיווחים ממשתמשים.</p>';
          } else {
            content = `
              <p style="margin-bottom: 1rem; color: var(--text-secondary);">${rows.length} מילים דווחו על ידי משתמשים, מהמדווחת ביותר.</p>
              <div style="max-height: 60vh; overflow-y: auto;">
                ${rows.map(r => `
                  <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-light); gap: 0.75rem;">
                    <div><strong>${this.escapeHtml(r.english)}</strong> - ${this.escapeHtml(r.hebrew)}</div>
                    <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                      <span style="color: var(--red); font-weight: 600; font-size: 0.85rem;">${r.reporterCount} דיווח${r.reporterCount > 1 ? 'ים' : ''}</span>
                      <button onclick="app.editWordGlobal(${r.wordId})" class="btn btn-sm btn-secondary">✏️ ערוך</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            `;
          }
          this.showModal('🛠️ דוחות מילים מכל המשתמשים', content);
        }).catch((error) => {
          this.showModal('🛠️ דוחות מילים', `<p style="text-align: center; color: var(--red);">שגיאה בטעינת דוחות: ${this.escapeHtml(error.message)}</p>`);
        });
      }

      showFlaggedWordsModal() {
        const flagged = this.words.filter(w => w.flagged);
        const isOwner = this.isOwner();
        let content;
        if (flagged.length === 0) {
          content = `
            <p style="text-align: center; color: var(--text-secondary);">
              לא סימנת עדיין אף מילה. אם תיתקל בתרגום שנראה לא נכון בזמן השינון, אפשר לסמן אותו עם 🚩 כדי שאבדוק אותו.
            </p>
          `;
        } else {
          content = `
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
              המילים האלה סומנו כדי שאבדוק אותן. אפשר לבטל סימון בכל רגע.
            </p>
            <div style="max-height: 50vh; overflow-y: auto;">
              ${flagged.map(w => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-light); gap: 0.75rem;">
                  <div>
                    <strong>${this.escapeHtml(w.english)}</strong> - ${this.escapeHtml(w.hebrew)}
                  </div>
                  <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
                    ${isOwner ? `<button onclick="app.editWordGlobal(${w.id})" class="btn btn-sm btn-secondary">✏️ ערוך</button>` : ''}
                    <button onclick="app.toggleFlag(${w.id}); app.showFlaggedWordsModal();" class="btn btn-sm btn-secondary">בטל סימון</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `;
        }
        this.showModal('🚩 מילים שסומנו', content);
      }

      // True only for the app owner's own logged-in account - see
      // loadWordOverrides for why edits are gated this way instead of
      // being open to every user.
      isOwner() {
        return !!(currentUser && currentUser.email === 'eilaydror@gmail.com');
      }

      // Opens an editor for a word's English spelling / Hebrew meaning /
      // example sentence. Owner-only: this writes to the shared
      // `wordOverrides` node (see loadWordOverrides), which corrects the
      // word for every user, not just the current device.
      editWordGlobal(wordId) {
        if (!this.isOwner()) return;
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;
        const content = `
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <label style="font-weight: 600; font-size: 0.9rem;">אנגלית
              <input type="text" id="edit-english-${wordId}" value="${this.escapeHtml(word.english)}" style="width: 100%; margin-top: 0.3rem; padding: 0.6rem; font-size: 0.95rem; direction: ltr; border: 1px solid var(--border-light); border-radius: 10px;">
            </label>
            <label style="font-weight: 600; font-size: 0.9rem;">משמעות בעברית
              <input type="text" id="edit-hebrew-${wordId}" value="${this.escapeHtml(word.hebrew)}" style="width: 100%; margin-top: 0.3rem; padding: 0.6rem; font-size: 0.95rem; direction: rtl; border: 1px solid var(--border-light); border-radius: 10px;">
            </label>
            <label style="font-weight: 600; font-size: 0.9rem;">משפט לדוגמה
              <input type="text" id="edit-example-${wordId}" value="${this.escapeHtml(word.example || '')}" style="width: 100%; margin-top: 0.3rem; padding: 0.6rem; font-size: 0.95rem; direction: ltr; border: 1px solid var(--border-light); border-radius: 10px;">
            </label>
            <button class="btn btn-primary" style="width: 100%; margin-top: 0.5rem;" onclick="app.saveWordOverride(${wordId})">שמור תיקון</button>
          </div>
        `;
        this.showModal(`✏️ עריכת מילה`, content);
      }

      saveWordOverride(wordId) {
        if (!this.isOwner()) return;
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;

        const englishInput = document.getElementById(`edit-english-${wordId}`);
        const hebrewInput = document.getElementById(`edit-hebrew-${wordId}`);
        const exampleInput = document.getElementById(`edit-example-${wordId}`);
        const english = englishInput.value.trim();
        const hebrew = hebrewInput.value.trim();
        const example = exampleInput.value.trim();
        if (!english || !hebrew) return;

        word.english = english;
        word.hebrew = hebrew;
        word.example = example;

        db.ref(`wordOverrides/${wordId}`).set({
          english,
          hebrew,
          example,
          updatedAt: firebase.database.ServerValue.TIMESTAMP,
          updatedBy: currentUser.email
        }).catch((error) => {
          // The word object above is already mutated locally and the
          // modal below reports success, so a failed shared write needs
          // its own visible warning - otherwise the owner believes the
          // correction is live for every user, while it will actually
          // silently revert on this device's next loadWordOverrides()
          // (or never even reach other users at all) with no indication
          // anything went wrong beyond a console warning nobody reads.
          console.warn('Could not save word override:', error.message);
          this.showModal('⚠️ שגיאת שמירה', `<p>העריכה נשמרה במכשיר הזה בלבד - השמירה המשותפת (לכל המשתמשים) נכשלה: ${this.escapeHtml(error.message)}</p><p>נסה שוב מאוחר יותר.</p>`);
        });

        this.closeModal();
        this.render();
      }

      // Lets someone undo a mastery they don't actually trust (e.g. they
      // guessed right twice by luck) - sends the word back to the active
      // queue from scratch, same as if it had never been answered.
      unmasterWord(wordId) {
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;
        word.status = 'red';
        word.streak = 0;
        word.dueAt = null;
        word.updatedAt = Date.now();
        this.saveProgress();
        this.showMasteredWordsModal();
      }

      showMasteredWordsModal() {
        const mastered = this.words.filter(w => w.status === 'green');
        let content;
        if (mastered.length === 0) {
          content = `
            <p style="text-align: center; color: var(--text-secondary);">
              עדיין אין לכם מילים ששלטתם בהן. ברגע שתזכרו מילה נכון לאורך כל סבב החזרה המרווחת, היא תופיע כאן.
            </p>
          `;
        } else {
          content = `
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
              ${mastered.length} מילים ששלטתם בהן. אם מילה בעצם לא ידועה לכם טוב - אפשר להחזיר אותה לשינון.
            </p>
            <div style="max-height: 50vh; overflow-y: auto;">
              ${mastered.map(w => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-light); gap: 0.75rem;">
                  <div>
                    <strong>${this.escapeHtml(w.english)}</strong> - ${this.escapeHtml(w.hebrew)}
                  </div>
                  <button onclick="app.unmasterWord(${w.id})" class="btn btn-sm btn-secondary" style="flex-shrink: 0;">החזר לשינון</button>
                </div>
              `).join('')}
            </div>
          `;
        }
        this.showModal('✅ מילים ששלטתי בהן', content);
      }

      // Full A-Z reference list of every word in the deck, grouped by
      // difficulty tier and collapsed by default (opening all three at
      // once would render ~4000 rows). The search box filters by matching
      // ids in-memory first (cheap - a few thousand string compares) and
      // then just toggles DOM visibility, rather than re-rendering.
      showFullWordListModal() {
        const groups = [
          { key: 'easy', label: '🟢 קל' },
          { key: 'moderate', label: '🟡 בינוני' },
          { key: 'hard', label: '🔴 קשה' }
        ];
        const statusColor = { red: 'var(--red)', orange: 'var(--orange)', green: 'var(--green)' };

        const renderRow = (w) => `
          <div class="full-word-row" data-id="${w.id}" onclick="app.toggleFullWordListMeaning(this)"
            style="display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.3rem; border-bottom: 1px solid var(--border-light); cursor: pointer;">
            <div style="width: 10px; height: 10px; border-radius: 50%; background: ${statusColor[w.status] || 'var(--red)'}; flex-shrink: 0;"></div>
            <div style="flex: 1; min-width: 0;">
              <strong>${this.escapeHtml(w.english)}</strong>
              <span class="full-word-meaning" style="display: none; color: var(--text-secondary);"> - ${this.escapeHtml(w.hebrew)}</span>
            </div>
            <span class="full-word-hint" style="font-size: 0.75rem; color: var(--text-secondary); flex-shrink: 0;">הקש לתרגום 👆</span>
          </div>
        `;

        const groupsHtml = groups.map(g => {
          const words = this.words.filter(w => w.difficulty === g.key);
          const mastered = words.filter(w => w.status === 'green').length;
          return `
            <details class="full-word-group" style="margin-bottom: 0.75rem;">
              <summary style="cursor: pointer; font-weight: 600; padding: 0.6rem 0;">
                ${g.label} - ${words.length.toLocaleString()} מילים (${mastered.toLocaleString()} שולט)
              </summary>
              <div>${words.map(renderRow).join('')}</div>
            </details>
          `;
        }).join('');

        const content = `
          <div>
            <input type="text" id="full-word-list-search" placeholder="חיפוש מילה..."
              oninput="app.filterFullWordList(this.value)"
              style="width: 100%; padding: 0.6rem 0.8rem; border: 1px solid var(--border-light); border-radius: 2px; font-family: inherit; font-size: 0.95rem; margin-bottom: 1rem; box-sizing: border-box; direction: rtl;">
            <div style="max-height: 55vh; overflow-y: auto;">
              ${groupsHtml}
            </div>
          </div>
        `;

        this.showModal(`📋 רשימת כל המילים (${this.words.length.toLocaleString()})`, content);
      }

      toggleFullWordListMeaning(rowEl) {
        const meaning = rowEl.querySelector('.full-word-meaning');
        const hint = rowEl.querySelector('.full-word-hint');
        if (!meaning) return;
        const revealed = meaning.style.display !== 'none';
        meaning.style.display = revealed ? 'none' : 'inline';
        if (hint) hint.style.display = revealed ? '' : 'none';
      }

      filterFullWordList(query) {
        const q = query.trim().toLowerCase();
        const matchedIds = q
          ? new Set(this.words.filter(w => w.english.toLowerCase().includes(q) || w.hebrew.toLowerCase().includes(q)).map(w => w.id))
          : null;

        document.querySelectorAll('#modal-body .full-word-row').forEach(row => {
          const visible = !matchedIds || matchedIds.has(Number(row.dataset.id));
          row.style.display = visible ? 'flex' : 'none';
        });

        document.querySelectorAll('#modal-body .full-word-group').forEach(group => {
          if (!q) {
            group.style.display = '';
            group.open = false;
            return;
          }
          const hasVisible = Array.from(group.querySelectorAll('.full-word-row')).some(r => r.style.display !== 'none');
          group.style.display = hasVisible ? '' : 'none';
          group.open = true;
        });
      }

      showProgressModal() {
        const difficulties = [
          { key: 'easy', label: '🟢 קל' },
          { key: 'moderate', label: '🟡 בינוני' },
          { key: 'hard', label: '🔴 קשה' }
        ];

        const breakdownHtml = difficulties.map(d => {
          const words = this.words.filter(w => w.difficulty === d.key);
          const total = words.length;
          const green = words.filter(w => w.status === 'green').length;
          const orange = words.filter(w => w.status === 'orange').length;
          const red = total - green - orange;
          const pct = total > 0 ? Math.round((green / total) * 100) : 0;
          return `
            <div style="margin-bottom: 1.1rem;">
              <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 0.35rem;">
                <span>${d.label}</span>
                <span style="color: var(--text-secondary);">${green}/${total} שולט (${pct}%)</span>
              </div>
              <div style="display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: var(--light-sage);">
                <div style="width: ${total ? (green / total) * 100 : 0}%; background: var(--green);"></div>
                <div style="width: ${total ? (orange / total) * 100 : 0}%; background: var(--orange);"></div>
                <div style="width: ${total ? (red / total) * 100 : 0}%; background: var(--red);"></div>
              </div>
            </div>
          `;
        }).join('');

        // Last 14 days of study activity, from studyHistory (date -> session count).
        const days = [];
        for (let i = 13; i >= 0; i--) {
          const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const key = this.getLocalDateKey(d);
          days.push({ count: this.studyHistory[key] || 0, label: d.toLocaleDateString('he-IL', { weekday: 'short' }) });
        }
        const maxCount = Math.max(1, ...days.map(d => d.count));

        const heatmapHtml = `
          <div style="display: flex; gap: 0.3rem; align-items: flex-end; height: 70px;">
            ${days.map(d => {
              const heightPct = d.count > 0 ? Math.max(15, (d.count / maxCount) * 100) : 6;
              const bg = d.count > 0 ? 'var(--sage-green)' : 'var(--border-light)';
              return `<div style="flex: 1; height: ${heightPct}%; background: ${bg}; border-radius: 3px;" title="${d.count} שיעורים"></div>`;
            }).join('')}
          </div>
          <div style="display: flex; gap: 0.3rem; margin-top: 0.3rem;">
            ${days.map(d => `<div style="flex: 1; text-align: center; font-size: 0.65rem; color: var(--text-secondary);">${d.label}</div>`).join('')}
          </div>
        `;

        const totalMastered = this.words.filter(w => w.status === 'green').length;

        const content = `
          <div>
            <p style="margin-bottom: 1.5rem; color: var(--text-secondary); text-align: center;">
              עד עכשיו שלטת ב-${totalMastered} מילים מתוך ${this.words.length}. כל התקדמות נספרת! 💪
            </p>
            <h4 style="margin-bottom: 0.75rem; font-weight: 600;">📊 שליטה לפי רמת קושי</h4>
            ${breakdownHtml}
            <h4 style="margin: 1.25rem 0 0.5rem; font-weight: 600;">📅 פעילות ב-14 הימים האחרונים</h4>
            ${heatmapHtml}
          </div>
        `;

        this.showModal('📈 ההתקדמות שלי', content);
      }

      // Lightweight friend/social feature: users add each other by sharing
      // their Firebase uid as a "code" (no email lookup needed - that would
      // require a backend function we don't have). Only aggregate public
      // stats are exposed via publicProfiles/{uid}, never per-word progress.
      // Requires the Firebase RTDB security rules below to be added in the
      // Firebase console:
      //
      // "publicProfiles": {
      //   "$uid": { ".read": "auth != null", ".write": "$uid === auth.uid" }
      // },
      // "users": {
      //   "$uid": {
      //     "friends": { ".read": "$uid === auth.uid", ".write": "$uid === auth.uid" }
      //   }
      // }
      showFriendsModal() {
        if (!firebaseReady || !currentUser) {
          this.showModal('👥 חברים', `
            <p style="text-align: center; color: var(--text-secondary);">
              כדי להוסיף חברים ולהשוות רצפים, צריך להתחבר עם חשבון (לא במצב "המשך ללא כניסה").
            </p>
          `);
          return;
        }

        const content = `
          <div>
            <p style="margin-bottom: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">הקוד שלך לשיתוף - שלח לחבר כדי שיוסיף אותך:</p>
            <div style="display: flex; gap: 0.5rem; margin-bottom: 1.25rem;">
              <input id="my-friend-code" type="text" readonly value="${currentUser.uid}" style="flex: 1; padding: 0.5rem; font-size: 0.75rem; border: 1px solid var(--border-light); border-radius: 8px; direction: ltr; text-align: left; background: var(--bg-light);">
              <button class="btn btn-sm btn-secondary" onclick="app.copyFriendCode()">העתק</button>
            </div>

            <p style="margin-bottom: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">הוסף חבר לפי הקוד שקיבלת ממנו:</p>
            <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem;">
              <input id="add-friend-code" type="text" placeholder="הדבק קוד חבר..." style="flex: 1; padding: 0.5rem; font-size: 0.8rem; border: 1px solid var(--border-light); border-radius: 8px; direction: ltr; text-align: left;">
              <button class="btn btn-sm btn-primary" onclick="app.addFriendByCode()">הוסף</button>
            </div>

            <div id="friends-list-container">
              <p style="text-align: center; color: var(--text-secondary); font-size: 0.85rem;">טוען חברים...</p>
            </div>
          </div>
        `;
        this.showModal('👥 חברים', content);
        this.renderFriendsList();
      }

      copyFriendCode() {
        const input = document.getElementById('my-friend-code');
        if (!input) return;
        input.select();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(input.value).catch(() => {});
        }
      }

      addFriendByCode() {
        const input = document.getElementById('add-friend-code');
        if (!input) return;
        const code = input.value.trim();
        if (!code || code === currentUser.uid) {
          input.value = '';
          return;
        }
        this.friends[code] = true;
        db.ref(`users/${currentUser.uid}/friends/${code}`).set(true).catch((error) => {
          console.warn('Could not save friend:', error.message);
        });
        input.value = '';
        this.renderFriendsList();
      }

      removeFriend(friendUid) {
        delete this.friends[friendUid];
        db.ref(`users/${currentUser.uid}/friends/${friendUid}`).remove().catch((error) => {
          console.warn('Could not remove friend:', error.message);
        });
        this.renderFriendsList();
      }

      renderFriendsList() {
        const container = document.getElementById('friends-list-container');
        if (!container) return;

        const friendIds = Object.keys(this.friends);
        if (friendIds.length === 0) {
          container.innerHTML = `<p style="text-align: center; color: var(--text-secondary); font-size: 0.85rem;">עדיין אין לך חברים מחוברים. שתף את הקוד שלך כדי להתחיל!</p>`;
          return;
        }

        Promise.all(friendIds.map(uid =>
          db.ref(`publicProfiles/${uid}`).once('value').then(snap => ({ uid, profile: snap.exists() ? snap.val() : null }))
        )).then(results => {
          container.innerHTML = results.map(({ uid, profile }) => {
            if (!profile) {
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-light);">
                  <span style="color: var(--text-secondary); font-size: 0.85rem;">חבר לא נמצא</span>
                  <button onclick="app.removeFriend('${uid}')" class="btn btn-sm btn-secondary">הסר</button>
                </div>
              `;
            }
            return `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-light);">
                <div>
                  <strong>${app.escapeHtml(profile.displayName)}</strong>
                  <div style="font-size: 0.8rem; color: var(--text-secondary);">🔥 ${profile.streak || 0} ימים · ✅ ${profile.masteredCount || 0} מילים</div>
                </div>
                <button onclick="app.removeFriend('${uid}')" class="btn btn-sm btn-secondary">הסר</button>
              </div>
            `;
          }).join('');
        }).catch((error) => {
          container.innerHTML = `<p style="text-align: center; color: var(--red); font-size: 0.85rem;">שגיאה בטעינת חברים.</p>`;
          console.warn('Could not load friend profiles:', error.message);
        });
      }

      // Tracks the finger/mouse in real time so the card actually follows
      // the drag (translate + slight rotation, live) instead of staying
      // frozen until release - that dead period was what made swiping feel
      // laggy/inaccurate. A vertical scroll is only blocked once the drag
      // is confidently horizontal, so normal page scrolling still works.
      setupCardSwipeDetection(element, word) {
        const minSwipeDistance = 90;
        let startX = 0, startY = 0, currentX = 0;
        let dragging = false, decided = false, horizontal = false;

        const beginDrag = (x, y) => {
          startX = x; startY = y; currentX = x;
          dragging = true; decided = false; horizontal = false;
          element.style.transition = 'none';
        };

        const updateDrag = (x, y, evt) => {
          if (!dragging) return;
          const dx = x - startX;
          const dy = y - startY;
          if (!decided && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
            decided = true;
            horizontal = Math.abs(dx) > Math.abs(dy);
          }
          if (!horizontal) return;
          if (evt && evt.cancelable) evt.preventDefault();
          currentX = x;
          element.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
          element.style.opacity = String(Math.max(0.45, 1 - Math.abs(dx) / 400));
        };

        const resetCard = () => {
          element.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
          element.style.transform = '';
          element.style.opacity = '1';
        };

        const endDrag = () => {
          if (!dragging) return;
          dragging = false;
          if (!horizontal) { resetCard(); return; }

          const dx = currentX - startX;
          if (Math.abs(dx) < minSwipeDistance) { resetCard(); return; }

          this._justSwiped = true;
          if (dx > 0) {
            const wasRevealed = this._revealed;
            this.attemptGradeKnown(word);
            // Not revealed yet: attemptGradeKnown only flipped the card
            // face-up, it didn't grade/remove it - snap back to center
            // instead of leaving it dragged off to the side.
            if (!wasRevealed) resetCard();
          } else {
            this.gradeCurrentCard(word, false);
          }
        };

        element.addEventListener('touchstart', (e) => {
          const t = e.touches[0];
          beginDrag(t.clientX, t.clientY);
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
          const t = e.touches[0];
          updateDrag(t.clientX, t.clientY, e);
        }, { passive: false });

        element.addEventListener('touchend', endDrag);
        element.addEventListener('touchcancel', () => { dragging = false; resetCard(); });

        // Mouse drag (desktop testing / trackpad)
        let mouseDown = false;
        element.addEventListener('mousedown', (e) => {
          mouseDown = true;
          beginDrag(e.clientX, e.clientY);
        });
        window.addEventListener('mousemove', (e) => {
          if (!mouseDown) return;
          updateDrag(e.clientX, e.clientY, e);
        });
        window.addEventListener('mouseup', () => {
          if (!mouseDown) return;
          mouseDown = false;
          endDrag();
        });
      }

      gradeCurrentCard(word, correct) {
        // The actual grade doesn't apply until the setTimeout below fires,
        // ~220ms later - until then word.status hasn't changed, so
        // getCurrentSessionWord() keeps returning this same word. Without
        // this lock, holding an arrow key (native keydown auto-repeat),
        // or a swipe immediately followed by a keypress, queues a second
        // grade against the same still-red/orange word; both timeouts
        // then fire back-to-back and walk it forward two rungs of the
        // ORANGE_INTERVALS_MS ramp from a single continuous input,
        // skipping the "wait for the next rest period" spaced-repetition
        // rule entirely.
        if (this._gradingInFlight) return;
        this._gradingInFlight = true;

        // Animate the card off-screen, then apply the grade once the
        // animation has had time to play - makes swiping/keyboard grading
        // feel like a responsive deck of cards instead of an instant
        // content swap.
        const cardEl = document.getElementById('current-word-card');
        if (cardEl) {
          cardEl.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
          cardEl.style.transform = correct ? 'translateX(150%) rotate(10deg)' : 'translateX(-150%) rotate(-10deg)';
          cardEl.style.opacity = '0';
          cardEl.style.pointerEvents = 'none';
        }
        if (navigator.vibrate) navigator.vibrate(correct ? 12 : 25);
        this._lastGradeDir = correct ? 1 : -1;

        setTimeout(() => {
          this._gradingInFlight = false;
          if (correct) {
            this.markWordKnown(word);
          } else {
            this.markWordUnknown(word);
          }
        }, cardEl ? 220 : 0);
      }

      // One-click "I already know this word perfectly" - lets the learner
      // mark it mastered (green) immediately instead of waiting for two
      // separate correct answers across a rest period. Distinct from the
      // regular "מכיר" grade button (which only ever advances a word one
      // step, red->orange or orange->green) and gated behind a confirm()
      // so a swipe/tap that lands slightly off the normal grade buttons
      // can't silently skip the spaced-repetition check. Everything after
      // the confirmation reuses markWordKnown's own green-state logic via
      // its `forceMaster` flag, so stats/tier-advance/undo all stay in
      // sync with the normal mastery path automatically.
      masterWordNow(word) {
        if (!word) return;
        const confirmed = confirm(`לסמן את "${word.english}" כמילה שאתם כבר יודעים מצוין, ולדלג ישר על החזרה המרווחת (המילה תסומן ירוקה עכשיו)?`);
        if (!confirmed) return;

        const cardEl = document.getElementById('current-word-card');
        if (cardEl) {
          cardEl.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
          cardEl.style.transform = 'translateX(150%) rotate(10deg)';
          cardEl.style.opacity = '0';
          cardEl.style.pointerEvents = 'none';
        }
        if (navigator.vibrate) navigator.vibrate(12);
        this._lastGradeDir = 1;

        setTimeout(() => {
          this.markWordKnown(word, true);
        }, cardEl ? 220 : 0);
      }

      // Ramp of rest periods a word climbs through while orange, each one
      // longer than the last - real spaced repetition needs recall to
      // survive progressively longer gaps before it counts as durably
      // learned, not just one short rest. word.streak indexes into this
      // (streak 1 -> ORANGE_INTERVALS_MS[0], etc.); a word only turns
      // green after surviving the full ramp, i.e. after correctly
      // recalling it once per interval below in sequence.
      static ORANGE_INTERVALS_MS = [
        4 * 60 * 60 * 1000,       // 4 hours
        24 * 60 * 60 * 1000,      // 1 day
        3 * 24 * 60 * 60 * 1000,  // 3 days
        7 * 24 * 60 * 60 * 1000   // 7 days
      ];

      // `forceMaster` is the one-click "I already know this perfectly"
      // path (see masterWordNow) - it skips straight to the same green
      // end-state the normal ramped-recall flow reaches after climbing
      // the full ORANGE_INTERVALS_MS ladder, instead of duplicating the
      // stats/tier/undo bookkeeping below in a second function.
      markWordKnown(word, forceMaster = false) {
        this.lastAction = { word, prevStatus: word.status, prevStreak: word.streak, prevUpdatedAt: word.updatedAt, prevDueAt: word.dueAt, prevFailCount: word.failCount, prevLeech: word.leech, wasCorrect: true };

        // Snapshot the tier before grading - if mastering this word happens
        // to complete the whole current tier, this changes below and we
        // celebrate the automatic advance to the next one.
        const prevTier = this.getCurrentTier();

        const intervals = this.constructor.ORANGE_INTERVALS_MS;

        // Progress the word's status
        if (forceMaster) {
          // Learner already knows it well and chose to skip the spaced-
          // repetition check entirely - mark it mastered immediately.
          word.status = 'green';
          word.streak = intervals.length + 1;
          word.dueAt = null;
        } else if (!word.status || word.status === 'red') {
          // First time: red -> orange. Rest before it's eligible for a
          // confirmation round again - real spaced repetition, not an
          // instant re-drill.
          word.status = 'orange';
          word.streak = 1;
          word.dueAt = Date.now() + intervals[0];
        } else if (word.status === 'orange') {
          if (word.streak < intervals.length) {
            // Correct again after resting - climb to the next, longer
            // rest period instead of mastering on just two answers. Words
            // that keep coming back correct get checked less and less
            // often; anything that slips gets caught by markWordUnknown
            // and dropped straight back to red for a full restart.
            word.streak += 1;
            word.dueAt = Date.now() + intervals[word.streak - 1];
          } else {
            // Survived the full rest ramp - now durably mastered.
            word.status = 'green';
            word.streak += 1;
            word.dueAt = null;
          }
        }
        word.updatedAt = Date.now();

        // Reaching mastery clears any leech history - whatever made this
        // word stubborn before is no longer relevant once it's actually
        // known. See markWordUnknown() for how a word becomes a leech.
        if (word.status === 'green') {
          word.failCount = 0;
          word.leech = false;
        }

        this.sessionStats.correct++;
        this.allTimeStats.totalAttempts++;
        this.allTimeStats.totalCorrect++;
        this.saveProgress();
        this.render();

        // Automatic tier progression: no manual level picker any more -
        // mastering the last word of a tier just silently unlocks the next
        // one, and this modal is the only thing announcing it.
        const newTier = this.getCurrentTier();
        if (newTier !== prevTier) {
          this.showTierUnlockedModal(newTier);
        }
      }

      markWordUnknown(word) {
        const prevIndex = this.currentSession.indexOf(word);
        this.lastAction = { word, prevStatus: word.status, prevStreak: word.streak, prevUpdatedAt: word.updatedAt, prevDueAt: word.dueAt, prevFailCount: word.failCount, prevLeech: word.leech, wasCorrect: false, prevIndex };

        // User swiped LEFT (doesn't know)
        if (word.status === 'orange') {
          // If was orange, go back to red (forgot it) - due immediately,
          // no rest period for a word you just got wrong.
          word.status = 'red';
          word.streak = 0;
          word.dueAt = null;
        }
        // If already red, stay red (no change)
        word.updatedAt = Date.now();

        // Total-fails counter, independent of streak (which only tracks
        // consecutive correct answers and resets on any miss). A word that
        // keeps coming back wrong across many separate sessions is a
        // "leech" - the term Anki uses for this exact pattern - and past
        // LEECH_THRESHOLD misses it stops being worth the same rotation
        // time as everything else. See showLeechWordsModal()/
        // reactivateLeech() for how the learner deals with it, and
        // startNewSession() for where leeches are excluded from new
        // sessions.
        word.failCount = (word.failCount || 0) + 1;
        const LEECH_THRESHOLD = 4;
        const justBecameLeech = !word.leech && word.failCount >= LEECH_THRESHOLD;
        if (justBecameLeech) word.leech = true;

        // Send the missed word to the back of this session's queue instead
        // of leaving it at the front - otherwise it would immediately come
        // back up as the next card. It still resurfaces later in the same
        // set, just after other words get a turn. Unless it just crossed
        // the leech threshold, in which case it's pulled out of the
        // session entirely - leaving it in would contradict the leech
        // modal's promise that it exits rotation immediately.
        if (prevIndex !== -1) {
          this.currentSession.splice(prevIndex, 1);
          if (!justBecameLeech) {
            this.currentSession.push(word);
          }
        }

        this.sessionStats.incorrect++;
        this.allTimeStats.totalAttempts++;
        this.saveProgress();
        this.render();

        if (justBecameLeech) this.showLeechModal(word);
      }

      // Shown once, the moment a word crosses the leech threshold - not a
      // scolding, just flagging that the normal two-correct-answers flow
      // isn't working for this specific word and it's being pulled out of
      // rotation until the learner deliberately brings it back (see
      // reactivateLeech()), so it stops eating a disproportionate share of
      // every future session.
      showLeechModal(word) {
        const content = `
          <div style="text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">🐌</div>
            <p style="font-size: 1.05rem; margin-bottom: 1rem;">
              <strong>${this.escapeHtml(word.english)}</strong> (${this.escapeHtml(word.hebrew)}) פספסת כבר ${word.failCount} פעמים.
            </p>
            <p style="color: var(--text-secondary); margin-bottom: 1.5rem; line-height: 1.7;">
              במקום להמשיך לחזור עליה בלי הצלחה, היא יוצאת זמנית מהסבבים הרגילים. אפשר להוסיף לה רמז אישי ולהחזיר אותה לשינון מ"מילים עקשניות" במסך הראשי כשתרצו.
            </p>
            <button class="btn btn-primary" onclick="app.closeModal()">הבנתי</button>
          </div>
        `;
        this.showModal('🐌 מילה עקשנית', content);
      }

      // Brings a leech word back into normal rotation - a deliberate,
      // learner-initiated reset (not automatic), since the whole point is
      // that this word needs a fresh approach, not just another silent
      // retry.
      reactivateLeech(wordId) {
        const word = this.words.find(w => w.id === wordId);
        if (!word) return;
        word.leech = false;
        word.failCount = 0;
        word.updatedAt = Date.now();
        this.saveProgress();
        this.render();
        this.showLeechWordsModal();
      }

      // Escapes regex metacharacters so an english word (e.g. one
      // containing an apostrophe) can safely be dropped into a RegExp.
      escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      // Builds one sentence-completion question from a word: its own
      // example sentence with the word itself blanked out, plus 3 wrong
      // options drawn from other words (same difficulty tier first, since
      // same-tier distractors are harder to rule out by "sounds too easy/
      // hard" alone - falling back to any other word if the tier doesn't
      // have enough). Returns null if the word's example doesn't actually
      // contain the word as a whole word (a handful of examples use an
      // inflected form) - that word just can't be quizzed this way.
      buildSentenceQuestion(word, allWords) {
        if (!word.example) return null;
        const re = new RegExp('\\b' + this.escapeRegExp(word.english) + '\\b', 'i');
        if (!re.test(word.example)) return null;
        const sentence = word.example.replace(re, '_____');

        const sameTier = allWords.filter(w => w.id !== word.id && w.difficulty === word.difficulty);
        const others = allWords.filter(w => w.id !== word.id && w.difficulty !== word.difficulty);
        const distractorPool = [...sameTier.sort(() => Math.random() - 0.5), ...others.sort(() => Math.random() - 0.5)];

        const seen = new Set([word.english.toLowerCase()]);
        const distractors = [];
        for (const candidate of distractorPool) {
          const key = candidate.english.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          // Keep the real word reference (not just its english string) -
          // the feedback screen shows each distractor's Hebrew meaning and
          // lets the learner add it straight into rehearsal, both of which
          // need the actual word object, not a copy of its text.
          distractors.push(candidate);
          if (distractors.length === 3) break;
        }
        if (distractors.length < 3) return null; // not enough words to build a fair question

        const optionWords = [word, ...distractors].sort(() => Math.random() - 0.5);
        return { word, sentence, optionWords };
      }

      // How many green words in a given tier can actually be turned into a
      // valid question (has an example sentence containing the word as a
      // whole word, and at least 3 distinct distractors) - drives both the
      // setup modal's live counts and the disabled state of its start
      // button. Recomputed on demand rather than cached, since it depends
      // on this.words which changes as the learner masters more words.
      countEligibleSentenceWords(tier) {
        const mastered = this.words.filter(w => w.status === 'green' && (tier === 'all' || w.difficulty === tier));
        return mastered.filter(w => this.buildSentenceQuestion(w, this.words) !== null).length;
      }

      // Entry point from the start-screen button - opens the tier/round-
      // size picker instead of jumping straight into a fixed 10-question
      // round, so the learner controls both which mastered words get
      // re-checked and how long the round runs (see launchSentenceGame()
      // for where the actual game starts).
      startSentenceGame() {
        if (this._sentenceSetupTier === undefined) this._sentenceSetupTier = 'all';
        if (this._sentenceSetupSize === undefined) this._sentenceSetupSize = 10;
        this.showSentenceGameSetupModal();
      }

      setSentenceGameSetupTier(tier) {
        this._sentenceSetupTier = tier;
        this.showSentenceGameSetupModal();
      }

      setSentenceGameSetupSize(size) {
        this._sentenceSetupSize = size === 'all' ? 'all' : parseInt(size, 10);
        this.showSentenceGameSetupModal();
      }

      showSentenceGameSetupModal() {
        const tiers = [
          { value: 'all', label: '🌈 כל הרמות' },
          { value: 'easy', label: '🟢 קל' },
          { value: 'moderate', label: '🟡 בינוני' },
          { value: 'hard', label: '🔴 קשה' }
        ];
        const sizeOptions = [10, 20, 'all'];
        const currentEligible = this.countEligibleSentenceWords(this._sentenceSetupTier);
        const notEnough = currentEligible < 4;

        const content = `
          <div style="text-align: center;">
            <p style="color: var(--text-secondary); margin-bottom: 1.25rem;">
              בחרו אילו מילים ששלטתם בהן לתרגל, וכמה שאלות בסבב.
            </p>

            <div style="margin-bottom: 1.25rem;">
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;">רמה</div>
              <div class="tier-segmented" role="group" aria-label="בחירת רמה לתרגול">
                ${tiers.map(t => `
                  <button type="button" class="tier-segment-btn${this._sentenceSetupTier === t.value ? ' active' : ''}" onclick="app.setSentenceGameSetupTier('${t.value}')">
                    ${t.label}
                  </button>
                `).join('')}
              </div>
            </div>

            <div style="margin-bottom: 1rem;">
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;">מספר שאלות בסבב</div>
              <div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap;">
                ${sizeOptions.map(s => `
                  <button type="button" class="btn btn-sm ${this._sentenceSetupSize === s ? 'btn-primary' : 'btn-secondary'}" onclick="app.setSentenceGameSetupSize('${s}')">
                    ${s === 'all' ? `כל ה-${currentEligible}` : s}
                  </button>
                `).join('')}
              </div>
            </div>

            <div style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1.25rem;">
              ${currentEligible.toLocaleString()} מילים ירוקות זמינות לתרגול ברמה שנבחרה
            </div>

            <button class="btn btn-primary" onclick="app.launchSentenceGame()" ${notEnough ? 'disabled' : ''} style="width: 100%;">
              🧩 התחל תרגול
            </button>
            ${notEnough ? `
              <div style="color: var(--red); font-size: 0.8rem; margin-top: 0.6rem;">
                אין מספיק מילים ירוקות ברמה זו (צריך לפחות 4). שננו עוד קצת או בחרו רמה אחרת.
              </div>
            ` : ''}
          </div>
        `;
        this.showModal('🧩 הגדרת תרגול השלמת משפטים', content);
      }

      // Quizzes words the learner already marked as known (green) with a
      // psychometric-style sentence completion - the normal flashcard
      // session never shows green words again (see renderSession), so this
      // is the only place mastery actually gets re-checked. A wrong answer
      // sends the word straight back into regular memorization (see
      // answerSentenceGame) instead of just recording a score, since a
      // missed "known" word is exactly the situation the app should react
      // to automatically.
      launchSentenceGame() {
        const tier = this._sentenceSetupTier;
        const size = this._sentenceSetupSize;
        const masteredWords = this.words.filter(w => w.status === 'green' && (tier === 'all' || w.difficulty === tier));
        let questions = masteredWords
          .sort(() => Math.random() - 0.5)
          .map(w => this.buildSentenceQuestion(w, this.words))
          .filter(Boolean);

        if (questions.length < 4) {
          // The setup modal's own button is disabled in this state, but
          // this is still reachable if the last word got demoted (e.g. a
          // parallel Firebase sync) between opening the modal and clicking
          // start.
          this.showSentenceGameSetupModal();
          return;
        }
        if (size !== 'all') questions = questions.slice(0, size);

        this.closeModal();
        this.sentenceGameQuestions = questions;
        this.sentenceGameIndex = 0;
        this.sentenceGameStats = { correct: 0, incorrect: 0 };
        this.sentenceGameAnswered = false;
        this.sentenceGameSelectedId = null;
        // Words the learner deliberately added to rehearsal from the
        // feedback screen (see addWordToRehearsal) - tracked for the whole
        // game, not per-question, so a distractor's "added" state survives
        // if it happens to reappear as a distractor in a later question.
        this.sentenceGameAddedIds = new Set();
        // Words actually missed this round, in order - surfaced by name in
        // the end-of-round summary (see finishSentenceGame) instead of
        // just a count, so the learner knows exactly which ones to watch
        // for in upcoming sessions.
        this.sentenceGameMissedWords = [];
        this.sentenceGameActive = true;
        this.render();
      }

      renderSentenceGame(appContent) {
        const current = this.sentenceGameQuestions[this.sentenceGameIndex];
        const total = this.sentenceGameQuestions.length;
        const word = current.word;
        const answered = this.sentenceGameAnswered;

        const optionsHtml = current.optionWords.map(opt => {
          const isCorrectOpt = opt.id === word.id;
          const isSelected = opt.id === this.sentenceGameSelectedId;
          let bg = 'var(--bg-light)';
          let border = 'var(--border-light)';
          if (answered) {
            if (isCorrectOpt) { bg = 'var(--light-sage)'; border = 'var(--green)'; }
            else if (isSelected) { bg = 'rgba(255, 107, 107, 0.12)'; border = 'var(--red)'; }
          }

          // Once answered, reveal every option's Hebrew meaning (not just
          // the correct one) - the learner picked between all four, so all
          // four are worth seeing translated. Distractors the learner
          // doesn't already know can be added straight into rehearsal from
          // here; the target word is excluded since a wrong answer already
          // sends it back into memorization automatically (see
          // answerSentenceGame), and a right answer means it's already
          // known.
          let belowHtml = '';
          if (answered) {
            const meaning = `<div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.35rem; direction: rtl;">${this.escapeHtml(opt.hebrew)}</div>`;
            let addHtml = '';
            if (!isCorrectOpt && opt.status !== 'green') {
              if (this.sentenceGameAddedIds.has(opt.id)) {
                addHtml = `<div style="margin-top: 0.4rem; font-size: 0.78rem; color: var(--sage-green); font-weight: 500;">✅ נוסף לשינון</div>`;
              } else {
                addHtml = `<button type="button" onclick="event.stopPropagation(); app.addWordToRehearsal(${opt.id})" style="margin-top: 0.4rem; background: none; border: none; color: var(--sage-green); cursor: pointer; font-size: 0.78rem; text-decoration: underline;">➕ הוסף גם אותה לשינון</button>`;
              }
            }
            belowHtml = meaning + addHtml;
          }

          // Kept as a div (not a <button>) because, once answered, it wraps
          // a real nested <button> (the "add to rehearsal" link below) -
          // a <button> inside a <button> is invalid HTML and gets
          // silently split apart by the parser. role="button" + tabindex
          // + a keydown handler give it the same keyboard/AT semantics as
          // a real button without that nesting problem.
          const interactiveAttrs = answered
            ? 'role="group"'
            : `role="button" tabindex="0" aria-label="${this.escapeHtml(opt.english)}" onclick="app.answerSentenceGame(${opt.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.answerSentenceGame(${opt.id});}"`;

          return `
            <div ${interactiveAttrs}
              style="padding: 0.9rem 1rem; border: 2px solid ${border}; background: ${bg}; border-radius: 10px; text-align: center; cursor: ${answered ? 'default' : 'pointer'};">
              <div style="font-size: 1rem; direction: ltr; font-weight: 500; color: var(--text-primary);">${this.escapeHtml(opt.english)}</div>
              ${belowHtml}
            </div>
          `;
        }).join('');

        const isCorrect = this.sentenceGameSelectedId === word.id;
        const feedbackHtml = answered ? `
          <div style="text-align: center; margin-top: 1.25rem;">
            <div style="font-weight: 600; margin-bottom: 0.4rem; color: ${isCorrect ? 'var(--sage-green)' : 'var(--red)'};">
              ${isCorrect ? '✅ נכון!' : '❌ לא בדיוק'}
            </div>
            <div style="background: var(--bg-light); border: 2px solid var(--sage-green); border-radius: 10px; padding: 1rem 1.1rem; margin-top: 0.5rem; direction: ltr; text-align: center;">
              <div style="font-size: 1.15rem; line-height: 1.7;">
                "${this.escapeHtml(word.example).replace(new RegExp(`\\b${word.english}\\b`, 'i'), `<strong style="color: var(--sage-green); text-decoration: underline;">${this.escapeHtml(word.english)}</strong>`)}"
              </div>
            </div>
            <div style="background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 10px; padding: 0.85rem 1rem; margin-top: 0.75rem; text-align: right; direction: rtl;">
              <div style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.25rem;">💡 הסבר</div>
              <div style="font-size: 0.95rem;">
                המילה הנכונה היא <strong style="direction: ltr; display: inline-block;">${this.escapeHtml(word.english)}</strong> - <strong>${this.escapeHtml(word.hebrew)}</strong>.
              </div>
            </div>
            ${!isCorrect ? `
              <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.6rem;">
                המילה הוחזרה לשינון הרגיל כדי שתתחזק שוב.
              </div>
            ` : ''}
            <button class="btn btn-primary" onclick="app.nextSentenceGameQuestion()" style="margin-top: 1rem;">
              ${this.sentenceGameIndex + 1 < total ? 'הבא ←' : 'סיום'}
            </button>
          </div>
        ` : '';

        appContent.innerHTML = `
          <div class="session-container">
            <div style="text-align: center; margin-bottom: 1.5rem;">
              <div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                שאלה ${this.sentenceGameIndex + 1} מתוך ${total}
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${(this.sentenceGameIndex / total) * 100}%"></div>
              </div>
            </div>

            <div class="word-card" style="cursor: default;">
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
                🧩 השלימו את המשפט
              </div>
              <div style="font-size: 1.2rem; line-height: 1.8; direction: ltr; text-align: center; margin-bottom: 1.5rem;">
                ${this.escapeHtml(current.sentence)}
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                ${optionsHtml}
              </div>
              ${feedbackHtml}
            </div>

            <div style="text-align: center; margin-top: 1.5rem;">
              <button onclick="app.exitSentenceGame()" class="btn" style="color: var(--red); border-color: var(--red);">
                ← יציאה מהתרגול
              </button>
            </div>
          </div>
        `;
      }

      answerSentenceGame(wordId) {
        if (this.sentenceGameAnswered) return;
        const current = this.sentenceGameQuestions[this.sentenceGameIndex];
        const word = current.word;
        const correct = wordId === word.id;

        this.sentenceGameAnswered = true;
        this.sentenceGameSelectedId = wordId;

        if (correct) {
          this.sentenceGameStats.correct++;
        } else {
          this.sentenceGameStats.incorrect++;
          // A "known" word that was actually missed shouldn't stay green -
          // send it back to the front of regular memorization, same as any
          // freshly-missed word, rather than just logging a wrong answer.
          word.status = 'red';
          word.streak = 0;
          word.dueAt = null;
          word.updatedAt = Date.now();
          this.saveProgress();
          this.sentenceGameMissedWords.push(word);
        }

        this.render();
      }

      // Lets the learner voluntarily pull an unfamiliar *distractor* word
      // (not the question's own target - that one's handled automatically,
      // see answerSentenceGame) into active rehearsal straight from the
      // feedback screen, for whenever a wrong option's revealed Hebrew
      // meaning turns out to be one they don't know either. Marks the word
      // "started" (updatedAt) so it's no longer capped by the new-word
      // intake limit in startNewSession, and due immediately - without
      // touching whatever status/streak it already has.
      addWordToRehearsal(wordId) {
        const word = this.words.find(w => w.id === wordId);
        if (!word || word.status === 'green') return;
        word.updatedAt = Date.now();
        word.dueAt = null;
        this.sentenceGameAddedIds.add(wordId);
        this.saveProgress();
        this.render();
      }

      nextSentenceGameQuestion() {
        if (this.sentenceGameIndex + 1 < this.sentenceGameQuestions.length) {
          this.sentenceGameIndex++;
          this.sentenceGameAnswered = false;
          this.sentenceGameSelectedId = null;
          this.render();
        } else {
          this.finishSentenceGame();
        }
      }

      finishSentenceGame() {
        const { correct, incorrect } = this.sentenceGameStats;
        const total = correct + incorrect;
        const missed = this.sentenceGameMissedWords;
        this.sentenceGameActive = false;
        this.render();

        const missedListHtml = missed.length > 0 ? `
          <div style="text-align: right; direction: rtl; max-height: 220px; overflow-y: auto; background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 10px; padding: 0.75rem 1rem; margin-top: 1rem;">
            ${missed.map(w => `
              <div style="padding: 0.4rem 0; ${w !== missed[missed.length - 1] ? 'border-bottom: 1px solid var(--border-light);' : ''}">
                <strong style="direction: ltr; display: inline-block;">${this.escapeHtml(w.english)}</strong> - ${this.escapeHtml(w.hebrew)}
              </div>
            `).join('')}
          </div>
        ` : '';

        this.showModal('🧩 סיימתם את התרגול', `
          <div style="text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">${incorrect === 0 ? '🎉' : '👏'}</div>
            <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">
              ענית נכון על <strong>${correct}</strong> מתוך <strong>${total}</strong>
            </p>
            ${incorrect > 0 ? `
              <p style="color: var(--text-secondary); line-height: 1.7;">
                ${incorrect} מילים שחשבתם ששלטתם בהן הוחזרו לשינון הרגיל - הן יופיעו שוב בשיעורים הבאים:
              </p>
              ${missedListHtml}
            ` : `
              <p style="color: var(--text-secondary);">
                כל הכבוד, כל המילים שנבדקו עדיין מוכרות היטב!
              </p>
            `}
            <button class="btn btn-primary" onclick="app.closeModal()" style="margin-top: 1rem;">סגור</button>
          </div>
        `);
      }

      exitSentenceGame() {
        if (confirm('לצאת מהתרגול? מילים שכבר נענו נשמרות כרגיל.')) {
          this.sentenceGameActive = false;
          this.render();
        }
      }

      showLeechWordsModal() {
        const leeches = this.words.filter(w => w.leech);
        let content;
        if (leeches.length === 0) {
          content = `
            <p style="text-align: center; color: var(--text-secondary);">
              אין כרגע מילים עקשניות. מילה שפוספסה כמה פעמים ברציפות תופיע כאן, יחד עם אפשרות להוסיף לה רמז אישי ולהחזיר אותה לשינון.
            </p>
          `;
        } else {
          content = `
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
              המילים האלה יצאו זמנית מהסבבים הרגילים כי הן פוספסו הרבה פעמים. הוסיפו רמז אישי ולחצו "החזר לשינון" כשתרצו לנסות שוב.
            </p>
            <div style="max-height: 55vh; overflow-y: auto;">
              ${leeches.map(w => `
                <div style="padding: 0.75rem 0; border-bottom: 1px solid var(--border-light);">
                  <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                    <div><strong>${this.escapeHtml(w.english)}</strong> - ${this.escapeHtml(w.hebrew)}</div>
                    <span style="color: var(--red); font-weight: 600; font-size: 0.8rem; flex-shrink: 0;">${w.failCount} פספוסים</span>
                  </div>
                  <textarea id="leech-assoc-${w.id}" placeholder="💭 כתוב דרך להיזכר..." style="width: 100%; padding: 0.5rem; font-size: 0.85rem; direction: rtl; border: 1px solid var(--border-light); border-radius: 10px; min-height: 45px; margin-bottom: 0.5rem;" onchange="app.updateAssociation(${w.id}, this.value)">${this.escapeHtml(w.association || '')}</textarea>
                  <button onclick="app.reactivateLeech(${w.id})" class="btn btn-sm btn-secondary" style="width: 100%;">🔄 החזר לשינון</button>
                </div>
              `).join('')}
            </div>
          `;
        }
        this.showModal('🐌 מילים עקשניות', content);
      }
      
      renderSessionEnd(appContent) {
        const totalWords = this.currentSession.length;
        const overallStats = this.getStats();

        // Most sessions end with words resting (answered correctly once,
        // now waiting ~4h before their confirmation round) rather than
        // fully mastered (green) - saying "mastered" here would directly
        // contradict the traffic-light explanation shown elsewhere in the
        // app, so the summary must reflect which of the two actually happened.
        const masteredInSession = this.currentSession.filter(w => w.status === 'green').length;
        const restingInSession = totalWords - masteredInSession;
        // totalWords can hit 0 mid-session: the only word left in rotation
        // was pulled out entirely the moment it crossed the leech threshold
        // (see markWordUnknown) rather than requeued, so there's nothing
        // left to call "mastered" here.
        const summaryText = totalWords === 0
          ? `מילה אחת סומנה כ"עקשנית" ויצאה מהסבב - אפשר להחזיר אותה לשינון דרך "מילים עקשניות" בתפריט.`
          : restingInSession === 0
          ? `שלטת בכל <strong>${totalWords}</strong> מילים בהישיבה זו! 🎉`
          : masteredInSession === 0
            ? `סיימת סבב על <strong>${totalWords}</strong> מילים! הן ינוחו כמה שעות ואז יחזרו לאישור סופי.`
            : `שלטת ב-<strong>${masteredInSession}</strong> מילים, ועוד <strong>${restingInSession}</strong> נמצאות בדרך - ינוחו כמה שעות ואז יחזרו לאישור סופי.`;

        let html = `
          <div class="session-container">
            <div class="session-end">
              <div class="session-end-title">שיעור הושלם! 🎉</div>

              <p style="color: var(--text-secondary); margin-bottom: 1.5rem; text-align: center;">
                ${summaryText}
              </p>

              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem; text-align: center;">
                <div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">התקדמות כללית</div>
                <div style="font-size: 2rem; font-weight: 600; color: var(--teal);">${overallStats.mastered} / ${this.words.length}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">מילים שולט</div>
              </div>
              
              <div class="session-stats">
                <div class="session-stat">
                  <div class="session-stat-value">${this.sessionStats.correct}</div>
                  <div class="session-stat-label">נכון</div>
                </div>
                <div class="session-stat">
                  <div class="session-stat-value">${this.sessionStats.incorrect}</div>
                  <div class="session-stat-label">לא נכון</div>
                </div>
              </div>
              
              <p style="color: var(--text-secondary); margin-bottom: 1.5rem; text-align: center;">
                המשך לסקור כדי להחזק את הזיכרון שלך!
              </p>
              
              <button class="btn btn-primary" onclick="app.endSession()">
                חזרה לבית
              </button>
            </div>
          </div>
        `;
        
        appContent.innerHTML = html;
      }
    }
    
    
    const app = new VocabularyApp();
    window.app = app;
