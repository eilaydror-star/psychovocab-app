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
        this.currentUser = null; // Firebase user
        this.userSkippedLogin = false; // Track if user skipped login screen
        
        // Difficulty filter - by default, study all difficulty levels
        // But weight by test probability
        this.difficultyFilter = { easy: true, moderate: true, hard: true };
        
        // Level progression
        this.levelProgression = 'free'; // 'free', 'easy', 'moderate', 'hard', 'structured'
        this.currentLevel = 'easy'; // Current level user is on
        this.unlockedLevels = { easy: true, moderate: false, hard: false }; // For structured mode
        this.showLevelSelector = true; // Show level selector on first load
        
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
        this.render();
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
        return WORDS_DATA.map(w => ({ ...w, dueAt: null, flagged: false, updatedAt: null }));
      }
      
      startNewSession() {
        // Filter remaining words by difficulty setting
        let remaining = this.words.filter(w => w.status !== 'green');

        // Filter by selected difficulty levels
        remaining = remaining.filter(w => {
          if (w.difficulty === 'easy') return this.difficultyFilter.easy;
          if (w.difficulty === 'moderate') return this.difficultyFilter.moderate;
          if (w.difficulty === 'hard') return this.difficultyFilter.hard;
          return true;
        });

        if (remaining.length === 0) return;

        // Real spaced repetition: a word you just got right (red -> orange)
        // rests for a few hours (see markWordKnown) before it's eligible
        // again, instead of being immediately re-drillable. Only words
        // that are actually due get selected into a new session.
        const now = Date.now();
        const due = remaining.filter(w => w.status === 'red' || !w.dueAt || w.dueAt <= now);

        if (due.length === 0) {
          this.showRestingModal(remaining);
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
        this.render();
      }

      recordStudySession() {
        // Tracks both a day-level streak (don't break the chain) and a
        // same-day session count (multiple short visits per day is how
        // real spaced repetition actually works, not one long daily cram).
        const today = new Date().toISOString().split('T')[0];
        this.studyHistory[today] = (this.studyHistory[today] || 0) + 1;

        if (this.lastStudyDate === today) {
          this.sessionsToday++;
          return;
        }

        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
          14: 'שבועיים ברצף - את/ה בונה הרגל אמיתי!',
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
        this.sessionActive = false;
        this.saveState();
        this.render();
      }
      
      toggleDifficulty(level) {
        // Toggle the difficulty filter
        this.difficultyFilter[level] = !this.difficultyFilter[level];
        
        // Ensure at least one difficulty is selected
        const anySelected = Object.values(this.difficultyFilter).some(v => v);
        if (!anySelected) {
          this.difficultyFilter[level] = true; // Re-enable the clicked one
        }
        
        this.saveState();
        this.render();
      }
      
      setLevelProgression(mode, startLevel = 'easy') {
        // mode: 'free' (all levels), 'easy', 'moderate', 'hard', 'structured' (easy→moderate→hard)
        this.levelProgression = mode;
        this.currentLevel = startLevel;
        this.showLevelSelector = false;
        // Once the user has picked a study mode, treat that as having
        // skipped/opted out of login, so they land on the start screen
        // instead of an (often non-functional) login wall.
        this.userSkippedLogin = true;
        
        if (mode === 'free') {
          // Free mode - access all levels
          this.difficultyFilter = { easy: true, moderate: true, hard: true };
        } else if (mode === 'structured') {
          // Structured mode - unlock gradually
          this.unlockedLevels = { easy: true, moderate: false, hard: false };
          this.currentLevel = 'easy';
          this.difficultyFilter = { easy: true, moderate: false, hard: false };
        } else {
          // Single level mode
          this.difficultyFilter = { easy: false, moderate: false, hard: false };
          this.difficultyFilter[mode] = true;
          this.currentLevel = mode;
        }
        
        this.saveState();
        this.render();
      }
      
      switchLevel(level) {
        // Switch to a different level (only if unlocked or in free mode)
        if (this.levelProgression === 'free' || this.unlockedLevels[level] || this.levelProgression === level) {
          this.currentLevel = level;
          this.difficultyFilter = { easy: false, moderate: false, hard: false };
          this.difficultyFilter[level] = true;
          this.saveState();
          this.render();
        }
      }
      
      unlockNextLevel() {
        // Unlock the next level in structured progression
        if (this.levelProgression === 'structured') {
          if (this.currentLevel === 'easy' && !this.unlockedLevels.moderate) {
            this.unlockedLevels.moderate = true;
            this.showLevelUnlockedModal('moderate');
          } else if (this.currentLevel === 'moderate' && !this.unlockedLevels.hard) {
            this.unlockedLevels.hard = true;
            this.showLevelUnlockedModal('hard');
          }
          this.saveState();
        }
      }
      
      showLevelUnlockedModal(level) {
        const levelNames = {
          'easy': '🟢 קל',
          'moderate': '🟡 בינוני',
          'hard': '🔴 קשה'
        };
        const levelEmoji = { 'easy': '🟢', 'moderate': '🟡', 'hard': '🔴' };
        
        const content = `
          <div style="text-align: center;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">${levelEmoji[level]}</div>
            <h2 style="color: var(--teal); margin-bottom: 1rem;">רמה חדשה נחשפה!</h2>
            <p style="font-size: 1.2rem; margin-bottom: 1.5rem;">
              אתה שלטת בכל המילים בהצלחה! 🎉
            </p>
            <p style="margin-bottom: 1.5rem;">
              עכשיו אתה יכול ללמוד מילים <strong>${levelNames[level]}</strong>
            </p>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <strong>💡 טיפ:</strong> הקשו יותר קשה!
            </div>
            <button class="btn btn-primary" onclick="app.closeModal(); app.switchLevel('${level}')">
              התחל ללמוד ${levelNames[level]}
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
            <h3 style="color: var(--teal); margin-bottom: 1.5rem; text-align: center;">📚 משאבי קריאה באנגלית</h3>
            
            <div style="margin-bottom: 2rem;">
              <h4 style="color: #51CF66; margin-bottom: 1rem;">🟢 קל - ספרים שכיחים ופשוטים</h4>
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 Project Gutenberg</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  אתר בחינם עם אלפי ספרים קלאסיים - התחל עם "Alice in Wonderland"
                </p>
                <a href="https://www.gutenberg.org" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.gutenberg.org
                </a>
              </div>
              
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 BBC Learning English</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  סיפורים קצרים וקלים עם שמע
                </p>
                <a href="https://www.bbc.com/learningenglish" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ BBC Learning English
                </a>
              </div>
              
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px;">
                <strong>📖 Wattpad - Young Adult</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  סיפורים משתמשים קלים בשפה פשוטה
                </p>
                <a href="https://www.wattpad.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.wattpad.com
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
                <strong>📖 Oxford Bookworms</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  ספרים עם מילים חיוניות מחדש
                </p>
                <a href="https://elt.oup.com/student/bookworms" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ Oxford Bookworms Series
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
                <strong>📖 The New York Times - Opinion</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מאמרי דעה מורכבים על נושאים מדיניים
                </p>
                <a href="https://www.nytimes.com/section/opinion" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ NYT Opinion Section
                </a>
              </div>
              
              <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 0.8rem;">
                <strong>📖 The Economist</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.5rem 0 0 0;">
                  מגזין עסקי וכלכלי בעל שפה מדויקת
                </p>
                <a href="https://www.economist.com" target="_blank" style="color: var(--teal); font-size: 0.9rem; text-decoration: none;">
                  ▶ www.economist.com
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
              תודה שאתה משתמש באפליקציה! 🙏
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
              בהצלחה במבחן - פסיכומטרי או אמירנט, מה שרלוונטי אליך. אתה תצליח! 💪
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

      toggleTranslation() {
        const hebrewEl = document.getElementById('hebrew-word');
        const hintEl = document.getElementById('toggle-hint');
        if (!hebrewEl) return;
        hebrewEl.classList.toggle('hidden');
        const isHidden = hebrewEl.classList.contains('hidden');
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
        const hintEl = document.getElementById('toggle-hint');
        if (hebrewEl) hebrewEl.classList.remove('hidden');
        if (hintEl) {
          hintEl.textContent = 'עכשיו כשראית את התרגום - החלק שוב ימינה לאישור שאתה יודע';
          hintEl.style.display = 'block';
          hintEl.style.color = 'var(--sage-green)';
        }
        this._revealed = true;
      }

      goBack() {
        // Exit session and return to menu - automatically save progress
        if (confirm('הגיע לך להפסיק את השיעור? ההתקדמות תישמר.')) {
          this.saveProgress(); // Auto-save before exiting
          this.sessionActive = false;
          this.sessionIndex = 0;
          this.render();
        }
      }

      undo() {
        // Revert the last markWordKnown/markWordUnknown action
        if (!this.lastAction) return;

        const { word, prevStatus, prevStreak, prevUpdatedAt, prevDueAt, wasCorrect, prevIndex } = this.lastAction;
        word.status = prevStatus;
        word.streak = prevStreak;
        word.updatedAt = prevUpdatedAt ?? null;
        word.dueAt = prevDueAt ?? null;

        // If the word had been requeued to the back of the session (a
        // missed word), put it back where it was.
        if (typeof prevIndex === 'number' && prevIndex !== -1) {
          const idx = this.currentSession.indexOf(word);
          if (idx !== -1) {
            this.currentSession.splice(idx, 1);
            this.currentSession.splice(prevIndex, 0, word);
          }
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
        const state = {
          words: this.words,
          allTimeStats: this.allTimeStats,
          difficultyFilter: this.difficultyFilter,
          levelProgression: this.levelProgression,
          currentLevel: this.currentLevel,
          unlockedLevels: this.unlockedLevels,
          currentStreak: this.currentStreak,
          sessionsToday: this.sessionsToday,
          lastStudyDate: this.lastStudyDate,
          studyHistory: this.studyHistory,
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
        // Automatically save word progress to localStorage AND Firebase
        this.saveState();
      }
      
      syncProgressWithFirebase() {
        // Save current progress to Firebase
        if (!firebaseReady || !currentUser) {
          console.log('Firebase not ready or user not logged in');
          return;
        }

        const userProgressRef = db.ref(`users/${currentUser.uid}/progress`);

        // Read the cloud copy first and merge per-word by updatedAt, instead
        // of blindly overwriting it. Without this, two devices open at the
        // same time (or one device with a stale in-memory copy) would have
        // whichever one saves last silently erase the other's progress on
        // words it never even touched.
        userProgressRef.once('value')
          .then((snapshot) => {
            const remoteWords = snapshot.exists() ? (snapshot.val().words || []) : [];
            const remoteMap = {};
            remoteWords.forEach(w => { remoteMap[w.id] = w; });

            this.words.forEach(localWord => {
              const remoteWord = remoteMap[localWord.id];
              if (remoteWord && (remoteWord.updatedAt || 0) > (localWord.updatedAt || 0)) {
                // The cloud has a newer change for this word (made on
                // another device) - take it instead of overwriting it.
                localWord.status = remoteWord.status;
                localWord.streak = remoteWord.streak;
                localWord.association = remoteWord.association;
                localWord.dueAt = remoteWord.dueAt ?? null;
                localWord.flagged = remoteWord.flagged ?? false;
                localWord.updatedAt = remoteWord.updatedAt ?? null;
              }
            });

            const progressData = {
              words: this.words,
              allTimeStats: this.allTimeStats,
              currentStreak: this.currentStreak,
              sessionsToday: this.sessionsToday,
              lastStudyDate: this.lastStudyDate,
              studyHistory: this.studyHistory,
              lastSaved: new Date().toISOString(),
              lastSyncedAt: firebase.database.ServerValue.TIMESTAMP
            };

            return userProgressRef.set(progressData);
          })
          .then(() => {
            console.log('Progress synced to Firebase');
            this.updatePublicProfile();
          })
          .catch((error) => {
            console.warn('Firebase sync failed, using localStorage:', error.message);
            this.saveState(); // Fallback to localStorage
          });
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
                }
              });

              this.words = freshWords;
              this.allTimeStats = data.allTimeStats || this.allTimeStats;
              this.currentStreak = data.currentStreak ?? this.currentStreak;
              this.sessionsToday = data.sessionsToday ?? this.sessionsToday;
              this.lastStudyDate = data.lastStudyDate ?? this.lastStudyDate;
              this.studyHistory = data.studyHistory ?? this.studyHistory;
              this.render();
            } else {
              console.log('No Firebase progress found, using local');
              this.loadProgressFromLocalStorage();
            }
            this.loadFriends();
          })
          .catch((error) => {
            console.warn('Failed to load from Firebase:', error.message);
            this.loadProgressFromLocalStorage();
          });
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
      
      loadState() {
        const data = loadFromLocalStorage();
        if (data) {
          
            // Keep fresh words but apply saved progress to them
            const savedWords = data.words;
            const freshWords = this.words;
            
            // Create a map of saved word statuses by ID
            const savedStatusMap = {};
            if (savedWords && Array.isArray(savedWords)) {
              savedWords.forEach(w => {
                savedStatusMap[w.id] = { status: w.status, streak: w.streak, association: w.association, dueAt: w.dueAt, flagged: w.flagged, updatedAt: w.updatedAt };
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
              }
            });

            this.words = freshWords; // Use fresh words array
            this.allTimeStats = data.allTimeStats;
            this.difficultyFilter = data.difficultyFilter || { easy: true, moderate: true, hard: true };
            this.levelProgression = data.levelProgression || 'free';
            this.currentLevel = data.currentLevel || 'easy';
            this.unlockedLevels = data.unlockedLevels || { easy: true, moderate: false, hard: false };
            this.currentStreak = data.currentStreak || 0;
            this.sessionsToday = data.sessionsToday || 0;
            this.lastStudyDate = data.lastStudyDate || null;
            this.studyHistory = data.studyHistory || {};
            this.showLevelSelector = false;
            this.lastSaved = data.lastSaved ? new Date(data.lastSaved) : null;
        }
      }
      
      exportProgress() {
        const state = {
          words: this.words,
          allTimeStats: this.allTimeStats,
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
            if (data.words && data.allTimeStats) {
              this.words = data.words;
              this.allTimeStats = data.allTimeStats;
              
              // Ensure all words have association field (for backwards compatibility)
              this.words.forEach(word => {
                if (!word.hasOwnProperty('association')) {
                  word.association = '';
                }
              });
              
              this.saveState();
              this.render();
              this.showModal('ייבוא הצליח! ✅ ✅', `<div class="success-message">ההתקדמות שלך נטענה בהצלחה!</div><p>מילים להשלמה: ${this.words.filter(w => w.status !== 'green').length}</p>`);
            } else {
              this.showModal('שגיאת ייבוא ❌', '<p>פורמט הקובץ אינו תקף. בחר קובץ שיוצא ממערכת שינון מילים באנגלית.</p>');
            }
          } catch (err) {
            this.showModal('שגיאת ייבוא ❌', '<p>לא יכול לקרוא את הקובץ. וודא שהוא קובץ JSON חוקי שיוצא ממערכת שינון מילים באנגלית.</p>');
          }
        };
        reader.readAsText(file);
        // Reset input so same file can be imported again
        event.target.value = '';
      }
      
      showModal(title, content) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = content;
        document.getElementById('modal-overlay').style.display = 'flex';
      }
      
      closeModal() {
        document.getElementById('modal-overlay').style.display = 'none';
      }
      
      setupModalClose() {
        const modal = document.getElementById('modal-overlay');
        if (modal) {
          modal.addEventListener('click', (e) => {
            if (e.target === modal) {
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
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.3rem;">זכרת את המילה בפעם הראשונה. אתה בדרך הנכונה!</p>
              </div>
              
              <div>
                <strong style="color: #51CF66;">🟩 ירוק - שולט!</strong>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 0.3rem;">זכרת פעמיים נכון ברציפות. המילה נשלטת!</p>
              </div>
            </div>
            
            <h3 style="color: var(--teal); margin: 1.5rem 0 1rem;">🔄 חזרה משכללת</h3>
            
            <p style="margin-bottom: 1rem; line-height: 1.8;">המערכת משתמשת במדע הוכח: חזרה משכללת משפרת זיכרון לטווח ארוך.</p>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 1:</strong> למדת מילה → רואה אותה שוב בעוד שעות
              </div>
              <div style="margin-bottom: 1rem; font-size: 0.95rem;">
                <strong>📍 שלב 2:</strong> זכרת אותה → רואה אותה בעוד 3-6 שעות
              </div>
              <div style="font-size: 0.95rem;">
                <strong>📍 שלב 3:</strong> זכרת פעמיים → רואה אותה בעוד יום לאישור סופי
              </div>
            </div>
            
            <h3 style="color: var(--teal); margin: 1.5rem 0 1rem;">⏰ לוח זמנים תיאורטי</h3>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem; font-size: 0.9rem;">
              <div style="margin-bottom: 0.8rem;"><strong>09:00 בבוקר:</strong> למדת "Ambitious" (אדום 🟥)</div>
              <div style="margin-bottom: 0.8rem;"><strong>11:00 בבוקר:</strong> ענית נכון (כתום 🟧)</div>
              <div style="margin-bottom: 0.8rem;"><strong>15:00 אחר הצהריים:</strong> ענית נכון שוב (ירוק 🟩 שולט!)</div>
              <div><strong>מחר בבוקר:</strong> תראה אותה לאישור סופי</div>
            </div>
            
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
        this.saveState();
        this.render();
      }
      
      setupKeyboardDetection() {
        document.addEventListener('keydown', this.keyboardHandler);
      }
      
      getScreenType() {
        // Mirrors the login-screen condition in render() exactly, so the
        // back-button history stack always agrees with what render()
        // actually shows.
        if ((firebaseReady && !currentUser && !this.userSkippedLogin) || (!this.userSkippedLogin && !currentUser && !this.sessionActive && !this.showLevelSelector)) {
          return 'login';
        }
        if (this.showLevelSelector) return 'level-selector';
        if (this.sessionActive) return 'session';
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
        } else if (screen === 'level-selector') {
          this.sessionActive = false;
          this.showLevelSelector = true;
        } else if (screen === 'start') {
          this.sessionActive = false;
          this.showLevelSelector = false;
        } else if (screen === 'session') {
          this.showLevelSelector = false;
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
        
        // Show level selector if first time or user resets
        if (this.showLevelSelector) {
          this.renderLevelSelector(appContent);
        } else if (!this.sessionActive) {
          this.renderStartScreen(appContent, stats);
        } else {
          this.renderSession(appContent);
        }

        this.setupModalClose();
        this.maybeShowTutorial();
      }

      // Auto-shows the beginner's guide exactly once per device, the first
      // time a new user reaches the level-selector/start screen (never
      // mid-session, so it can't interrupt a drill in progress). Uses its
      // own localStorage key, deliberately not synced through
      // saveState/Firebase - "have I seen the tutorial" is a per-device UI
      // fact, not learning progress.
      maybeShowTutorial() {
        if (this._tutorialCheckDone || this.sessionActive) return;
        this._tutorialCheckDone = true;
        try {
          if (!localStorage.getItem('psychovocab_tutorial_seen')) {
            localStorage.setItem('psychovocab_tutorial_seen', '1');
            this.showTutorialModal();
          }
        } catch (e) {
          // localStorage unavailable (e.g. private browsing) - just skip
          // the auto-popup, the manual "מדריך למתחילים" button still works.
        }
      }

      showTutorialModal() {
        const content = `
          <div style="max-height: 70vh; overflow-y: auto; direction: rtl;">
            <div style="background: var(--bg-light); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem; border: 1px solid var(--border-light);">
              <h3 style="color: var(--teal); margin-top: 0; margin-bottom: 0.75rem;">👋 ברוך הבא!</h3>
              <p style="margin: 0; line-height: 1.8; color: var(--text-secondary);">
                האפליקציה מלמדת אותך מילים באנגלית לפסיכומטרי, מילה אחת בכל פעם, עם חזרה חכמה שמתאימה את עצמה לכל מילה. הנה איך זה עובד:
              </p>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🃏 הכרטיס</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">1️⃣ תראה מילה באנגלית. נסה לזכור את התרגום <strong>לפני</strong> שאתה חושף אותו.</div>
              <div style="margin-bottom: 0.8rem;">2️⃣ לחץ/הקש על הכרטיס (או Space) כדי לחשוף את התרגום ולבדוק את עצמך.</div>
              <div>3️⃣ עכשיו סמן אם ידעת - זה הצעד שבאמת קובע את ההתקדמות שלך.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">👉👈 החלקה - איך מסמנים</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">
                <strong style="color: #51CF66;">➡️ ימינה = ״ידעתי״.</strong>
                <span style="color: var(--text-secondary);"> אם עוד לא ראית את התרגום, ההחלקה הראשונה רק תחשוף אותו (בדיוק כמו לחיצה) - זה כדי שלא תסמן ״ידעתי״ בטעות בלי לבדוק. החלק ימינה שוב כדי לאשר.</span>
              </div>
              <div>
                <strong style="color: #FF6B6B;">⬅️ שמאלה = ״לא ידעתי״.</strong>
                <span style="color: var(--text-secondary);"> מסמן מיד, בלי צורך לחשוף קודם. המילה תחזור אליך שוב בהמשך אותו שיעור, לא תיעלם.</span>
              </div>
              <div style="margin-top: 0.8rem; font-size: 0.85rem; color: var(--text-secondary);">
                🔘 לא בא לך להחליק? מתחת לכרטיס יש גם כפתורים עגולים ✓ מכיר / ✕ לא מכיר שעושים בדיוק אותו דבר.
              </div>
              <div style="margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-secondary);">
                💻 במחשב: אפשר גם עם החצים ← →, ו-Space לחשיפה.
              </div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🚦 הצבעים</h3>
            <p style="margin-bottom: 1rem; line-height: 1.8; color: var(--text-secondary);">
              כל מילה עוברת 🟥 אדום (חדשה) → 🟧 כתום (זכרת פעם) → 🟩 ירוק (זכרת פעמיים ברצף - שולט!). ההסבר המלא נמצא בכפתור ״מערכת הרמזור״ בתפריט הראשי.
            </p>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">🛠️ כלים בכרטיס</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 0.8rem;">📝 <strong>הוסף רמז אישי</strong> - כתוב דרך לזכור את המילה, או לחץ ״הצע לי אסוציאציה״ לקבל רעיון אוטומטי.</div>
              <div style="margin-bottom: 0.8rem;">🚩 <strong>סימון תרגום שגוי</strong> - אם תרגום נראה לא נכון, סמן אותו כדי שנבדוק אותו.</div>
              <div>↶ <strong>ביטול</strong> - טעית בהחלקה? כפתור הביטול (או מקש U) מחזיר את הסימון האחרון.</div>
            </div>

            <h3 style="color: var(--teal); margin-bottom: 0.75rem;">📅 איך ללמוד נכון</h3>
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light);">
              <div style="margin-bottom: 0.8rem;">✅ עדיף כמה שיעורים קצרים ביום מאשר שיעור ארוך אחד - זה מה שה-🔥 רצף וה-🎯 שיעורים היום בראש המסך עוקבים אחריו.</div>
              <div style="margin-bottom: 0.8rem;">✅ בתפריט הראשי אפשר לבחור רמת קושי (קל/בינוני/קשה) ומצב לימוד - חופשי או התקדמות מובנית.</div>
              <div>✅ ההתקדמות נשמרת אוטומטית במכשיר, ואם תתחבר עם חשבון - גם מסתנכרנת בין מכשירים.</div>
            </div>
          </div>
        `;

        this.showModal('🧭 מדריך למתחילים', content);
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
                    <label style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">דוא"ל</label>
                    <input type="email" id="login-email" placeholder="your@email.com" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>
                  
                  <div style="margin-bottom: 1.5rem;">
                    <label style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">סיסמה</label>
                    <input type="password" id="login-password" placeholder="••••••••" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>
                  
                  <div id="login-error" style="color: var(--red); margin-bottom: 1rem; font-size: 0.9rem; display: none;"></div>
                  
                  <button onclick="app.handleLogin()" style="width: 100%; padding: 0.75rem; background: var(--sage-green); color: white; border: none; border-radius: 2px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-bottom: 1rem;">
                    כניסה
                  </button>
                  
                  <p style="text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                    אין לך חשבון? <a href="#" onclick="app.toggleAuthForm(event)" style="color: var(--teal); text-decoration: none; font-weight: 500;">הרשמה</a>
                  </p>
                </div>
                
                <!-- Register Form -->
                <div id="register-form" style="display: none;">
                  <h2 style="font-size: 1.3rem; color: var(--dark-navy); margin-bottom: 1.5rem; text-align: center;">הרשמה</h2>
                  
                  <div style="margin-bottom: 1rem;">
                    <label style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">דוא"ל</label>
                    <input type="email" id="register-email" placeholder="your@email.com" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
                  </div>
                  
                  <div style="margin-bottom: 1rem;">
                    <label style="display: block; margin-bottom: 0.5rem; color: var(--text-primary); font-weight: 500;">סיסמה (לפחות 6 תווים)</label>
                    <input type="password" id="register-password" placeholder="••••••••" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-light); border-radius: 2px; font-size: 1rem;">
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
        this.showLevelSelector = true;
        this.render();
      }
      
      logout() {
        this.userSkippedLogin = false; // Reset so login screen shows again
        logoutUser()
          .then(() => {
            this.render();
          })
          .catch((error) => {
            console.error('Logout error:', error);
          });
      }
      
      renderLevelSelector(appContent) {
        const easyCount = this.words.filter(w => w.difficulty === 'easy').length;
        const modCount = this.words.filter(w => w.difficulty === 'moderate').length;
        const hardCount = this.words.filter(w => w.difficulty === 'hard').length;

        let html = `
          <div class="start-screen">
            <div class="start-title">🎯 בחר כיצד ללמוד</div>
            <div class="start-description" style="margin-bottom: 2rem;">
              בחר את אסטרטגיית הלימוד שלך:
            </div>
            
            <div style="display: grid; gap: 1rem; margin-bottom: 2rem;">
              <!-- Free Mode -->
              <button class="btn btn-primary" onclick="app.setLevelProgression('free')" 
                      style="padding: 1.5rem; text-align: left; font-size: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.1rem;">
                  🆓 בחר בחופשיות
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                  למד כל המילים מכל הרמות בו זמנית. אתה בשליטה מלאה!
                </div>
              </button>
              
              <!-- Structured Mode -->
              <button class="btn btn-primary" onclick="app.setLevelProgression('structured')" 
                      style="padding: 1.5rem; text-align: left; font-size: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.1rem;">
                  🏔️ התקדמות מובנית
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                  התחל קל → בינוני → קשה. שחרור רמות בהדרגה!
                </div>
              </button>
              
              <!-- Easy Only -->
              <button class="btn btn-secondary" onclick="app.setLevelProgression('easy')" 
                      style="padding: 1.5rem; text-align: left; font-size: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.1rem;">
                  🟢 רק קל
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                  ${easyCount.toLocaleString()} מילים שכיחות - בסיס יציב (90% בבחינה)
                </div>
              </button>
              
              <!-- Moderate Only -->
              <button class="btn btn-secondary" onclick="app.setLevelProgression('moderate')" 
                      style="padding: 1.5rem; text-align: left; font-size: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.1rem;">
                  🟡 רק בינוני
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                  ${modCount.toLocaleString()} מילים מדיום - אתגר בינוני (70% בבחינה)
                </div>
              </button>
              
              <!-- Hard Only -->
              <button class="btn btn-secondary" onclick="app.setLevelProgression('hard')" 
                      style="padding: 1.5rem; text-align: left; font-size: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.1rem;">
                  🔴 רק קשה
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                  ${hardCount.toLocaleString()} מילים נדירות - אלוף (35% בבחינה)
                </div>
              </button>
            </div>
            
            <div style="background: var(--bg-light); padding: 1rem; border-radius: 2px; border: 1px solid var(--border-light); margin-bottom: 1rem;">
              <strong>💡 המלצה:</strong> אם אתה מתחיל, בחר בהתקדמות מובנית או בחירה חופשית.
            </div>

            <button class="btn btn-secondary" onclick="app.showTutorialModal()" style="width: 100%;">
              🧭 מדריך למתחילים - איך משתמשים באפליקציה?
            </button>
          </div>
        `;

        appContent.innerHTML = html;
      }
      
      renderStartScreen(appContent, stats) {
        const allMastered = stats.remaining === 0;
        
        let html = `
          <div class="start-screen">
            <div class="start-title">מוכן לשנן?</div>
            <div class="start-description">
              שולט על מילים באנגלית לבחינת הפסיכומטרי.<br>
              התקדמות כללית: <strong>${stats.mastered}/3500</strong> מילים שולט<br>
              ${stats.remaining > 0 
                ? `יש לך <strong>${stats.remaining}</strong> מילים נותרים לשלוט.` 
                : `ברכות! שלטת בכל 3,500 המילים! 🎉`
              }
            </div>
        `;
        
        
        // Add difficulty filter section
        const easyCount = this.words.filter(w => w.difficulty === 'easy').length;
        const modCount = this.words.filter(w => w.difficulty === 'moderate').length;
        const hardCount = this.words.filter(w => w.difficulty === 'hard').length;
        
        html += `
          <div style="background: var(--bg-light); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem; border: 1px solid var(--border-light);">
            <div style="font-weight: 600; margin-bottom: 1rem; text-align: center; color: var(--sage-green);">
              🎯 בחר רמות קושי לשינון
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.8rem;">
              <button class="btn ${this.difficultyFilter.easy ? 'btn-primary' : 'btn-secondary'}" 
                      onclick="app.toggleDifficulty('easy')" 
                      style="font-size: 0.9rem; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100px;">
                🟢 קל<br><span style="font-size: 1.3rem; font-weight: 700; color: ${this.difficultyFilter.easy ? 'white' : 'var(--sage-green)'}; margin-top: 0.5rem;">${easyCount}</span>
              </button>
              <button class="btn ${this.difficultyFilter.moderate ? 'btn-primary' : 'btn-secondary'}" 
                      onclick="app.toggleDifficulty('moderate')" 
                      style="font-size: 0.9rem; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100px;">
                🟡 בינוני<br><span style="font-size: 1.3rem; font-weight: 700; color: ${this.difficultyFilter.moderate ? 'white' : 'var(--gold-accent)'}; margin-top: 0.5rem;">${modCount}</span>
              </button>
              <button class="btn ${this.difficultyFilter.hard ? 'btn-primary' : 'btn-secondary'}" 
                      onclick="app.toggleDifficulty('hard')" 
                      style="font-size: 0.9rem; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100px;">
                🔴 קשה<br><span style="font-size: 1.3rem; font-weight: 700; color: ${this.difficultyFilter.hard ? 'white' : 'var(--red)'}; margin-top: 0.5rem;">${hardCount}</span>
              </button>
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; margin-top: 1rem;">
              ♻️ לחץ על הכפתורים להשהיה/הפעלה
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
          </div>
        `;
        
        html += `
          <div class="traffic-light-legend">
            <h3>🚦 מערכת הרמזור</h3>
            
            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              כל מילה עוברת דרך שלושה שלבים עד שהיא נשלטת לחלוטין. בכל שיעור אתה רואה מילים אקראיות מכל השלבים. המטרה היא להגיע לשלב הירוק (✅ שלוט) עבור כל המילים!
            </p>
            
            <div class="legend-item">
              <div class="legend-dot" style="background: var(--red);"></div>
              <span><strong>🟥 אדום (חדש):</strong> המילה חדשה או קיבלת אותה בטעות. חזור לתחילה!</span>
            </div>
            
            <div class="legend-item">
              <div class="legend-dot" style="background: var(--orange);"></div>
              <span><strong>🟧 כתום (התחלה):</strong> זכרת את המילה פעם אחת נכון. אתה בדרך הנכונה!</span>
            </div>
            
            <div class="legend-item">
              <div class="legend-dot" style="background: var(--green);"></div>
              <span><strong>🟩 ירוק (שלוט):</strong> זכרת את המילה פעמיים נכון ברציפות. המילה נשלטת!</span>
            </div>
            
            <h3 style="margin-top: 2rem;">🔄 מערכת החזרה המרווחת (Spaced Repetition)</h3>
            
            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              אנחנו משתמשים במערכת מתמטית שהוכחה שמשפרת את הזיכרון לטווח ארוך:
            </p>
            
            <div style="background: var(--bg-card-hover); padding: 1.5rem; border-radius: 2px; margin-bottom: 1.5rem;">
              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 1 (אדום - חדש):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  למדת את המילה בפעם הראשונה. אתה תראה אותה שוב בשיעור הבא וביום זה (תוך שעות ספורות)
                </p>
              </div>
              
              <div style="margin-bottom: 1rem;">
                <strong>📍 שלב 2 (כתום - התחלה):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת אותה! עכשיו תראה אותה שוב בעוד 3-6 שעות. זה כדי לתחזק את הזיכרון שלך.
                </p>
              </div>
              
              <div>
                <strong>📍 שלב 3 (ירוק - שולט):</strong>
                <p style="color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.5rem;">
                  זכרת אותה פעמיים! המילה הוסרה מהתור הרגיל. תראה אותה שוב בעוד יום או יומיים כדי לוודא שנשארת בזיכרון.
                </p>
              </div>
            </div>
            
            <h3 style="margin-top: 2rem;">⏰ לוח זמנים לחזרה מרווחת במהלך היום</h3>
            
            <p style="margin-bottom: 1.5rem; line-height: 1.8;">
              <strong>דוגמה תיאורטית ללמידת מילה חדשה:</strong>
            </p>
            
            <div style="background: var(--bg-card-hover); padding: 1.5rem; border-radius: 2px;">
              <div style="display: grid; gap: 1rem;">
                <div>
                  <strong style="color: var(--teal);">09:00 בבוקר:</strong> למדת מילה חדשה "Ambitious" → 🟥 אדום
                </div>
                <div>
                  <strong style="color: var(--teal);">11:00 בבוקר:</strong> ראית את "Ambitious" שוב וענית נכון → 🟧 כתום
                </div>
                <div>
                  <strong style="color: var(--teal);">15:00 אחר הצהריים:</strong> ראית את "Ambitious" שוב וענית נכון → 🟩 ירוק (שולט!)
                </div>
                <div>
                  <strong style="color: var(--teal);">מחר בבוקר:</strong> תראה את "Ambitious" לבדיקה אחרונה → נשארת בזיכרון לטווח ארוך
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
              מילה נשלטת לחלוטין והוסרה מהתור הפעיל לאחר שענו נכון <strong>פעמיים ברציפות</strong>. שמור על ההישג חי!
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

            ${currentUser ? `
              <div style="margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--border-light);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                  <div style="display: flex; align-items: center; gap: 0.75rem;">
                    ${currentUser.photoURL
                      ? `<img src="${currentUser.photoURL}" alt="" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">`
                      : `<div style="width: 40px; height: 40px; border-radius: 50%; background: var(--sage-green); color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1rem; flex-shrink: 0;">${(currentUser.displayName || currentUser.email || '?').charAt(0).toUpperCase()}</div>`
                    }
                    <div>
                      <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 0.2rem;">ברוך הבא</p>
                      <p style="font-size: 1rem; font-weight: 600; color: var(--dark-navy); margin: 0;">${currentUser.displayName || currentUser.email}</p>
                    </div>
                  </div>
                  <button onclick="app.logout()" style="padding: 0.5rem 1.25rem; background: var(--red); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 500;">
                    ↗ יציאה
                  </button>
                </div>
              </div>
            ` : ''}
          </div>
        `;
        
        appContent.innerHTML = html;
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
        if (this._revealedForWordId !== word.id) {
          this._revealed = false;
          this._revealedForWordId = word.id;
        }

        let html = `
          <div class="session-container">
            <div style="text-align: center; margin-bottom: 1.5rem;">
              <div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                התקדמות: ${masteredCount}/${this.currentSession.length} מילים שולט
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${(masteredCount / this.currentSession.length) * 100}%"></div>
              </div>
            </div>

            <div class="word-card swipe-area" id="current-word-card">
              <div class="word-emoji">${word.emoji}</div>
              <div class="english-word">${word.english}</div>
              <div class="hebrew-translation hidden" id="hebrew-word">${word.hebrew}</div>
              <div id="toggle-hint" style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.5rem;">לחץ לגילוי התרגום</div>
              <button onclick="event.stopPropagation(); app.toggleNoteField(${word.id})" style="margin-top: 1.5rem; background: none; border: none; color: var(--sage-green); cursor: pointer; font-size: 0.85rem; text-decoration: underline;">
                📝 ${word.association ? 'ערוך רמז אישי' : 'הוסף רמז אישי - אסוציאציה מומלצת'}
              </button>
              <div id="note-field-wrapper" style="display: none; margin-top: 1rem;" onclick="event.stopPropagation()">
                <button onclick="app.suggestAssociation(${word.id})" type="button" style="margin-bottom: 0.6rem; background: var(--light-sage); border: 1px solid rgba(74, 122, 90, 0.25); color: var(--sage-green); cursor: pointer; font-size: 0.8rem; padding: 0.5rem 0.9rem; border-radius: 10px; font-weight: 500;">
                  💡 הצע לי אסוציאציה
                </button>
                <textarea id="assoc-${word.id}" placeholder="💭 כתוב דרך להיזכר, או לחץ למעלה לקבלת הצעה..." style="width: 100%; padding: 0.6rem; font-size: 0.85rem; direction: rtl; border: 1px solid var(--border-light); border-radius: 10px; min-height: 60px;" onchange="window.app.updateAssociation(${word.id}, this.value)">${word.association || ''}</textarea>
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
              <button class="grade-circle-btn dont-know" onclick="app.gradeCurrentCard(app.getCurrentSessionWord(), false)">
                <span class="grade-circle">✕</span>
                <span class="grade-label">לא מכיר</span>
              </button>
              <button class="grade-circle-btn know" onclick="app.attemptGradeKnown(app.getCurrentSessionWord())">
                <span class="grade-circle">✓</span>
                <span class="grade-label">מכיר</span>
              </button>
            </div>

            <div style="text-align: center; margin-top: 1.5rem;">
              <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 1rem;">
                Space לגילוי &nbsp;·&nbsp; U ביטול &nbsp;·&nbsp; B חזור לתפריט
              </div>
              <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
                <button onclick="app.undo()" class="btn btn-secondary">
                  ↶ ביטול (U)
                </button>
                <button onclick="app.goBack()" class="btn" style="color: var(--red); border-color: var(--red);">
                  ← חזור לתפריט (B)
                </button>
              </div>
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
        this.render();
      }

      showFlaggedWordsModal() {
        const flagged = this.words.filter(w => w.flagged);
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
                    <strong>${w.english}</strong> - ${w.hebrew}
                  </div>
                  <button onclick="app.toggleFlag(${w.id}); app.showFlaggedWordsModal();" class="btn btn-sm btn-secondary" style="flex-shrink: 0;">בטל סימון</button>
                </div>
              `).join('')}
            </div>
          `;
        }
        this.showModal('🚩 מילים שסומנו', content);
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
          const key = d.toISOString().split('T')[0];
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
                  <strong>${profile.displayName}</strong>
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

      setupCardSwipeDetection(element, word) {
        let touchStartX = 0;

        element.addEventListener('touchstart', (e) => {
          touchStartX = e.changedTouches[0].screenX;
        }, false);

        element.addEventListener('touchend', (e) => {
          const touchEndX = e.changedTouches[0].screenX;
          this.handleCardSwipe(touchStartX, touchEndX, word);
        }, false);

        // Also support mouse swipe (desktop testing / trackpad drag)
        let mouseDown = false;
        let mouseStartX = 0;

        element.addEventListener('mousedown', (e) => {
          mouseDown = true;
          mouseStartX = e.screenX;
        });

        element.addEventListener('mouseup', (e) => {
          if (mouseDown) {
            this.handleCardSwipe(mouseStartX, e.screenX, word);
            mouseDown = false;
          }
        });

        element.addEventListener('mouseleave', () => {
          mouseDown = false;
        });
      }

      handleCardSwipe(startX, endX, word) {
        const distance = endX - startX;
        const minSwipeDistance = 50;
        if (Math.abs(distance) < minSwipeDistance) return;

        this._justSwiped = true;
        if (distance > 0) {
          this.attemptGradeKnown(word);
        } else {
          this.gradeCurrentCard(word, false);
        }
      }

      gradeCurrentCard(word, correct) {
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

        setTimeout(() => {
          if (correct) {
            this.markWordKnown(word);
          } else {
            this.markWordUnknown(word);
          }
        }, cardEl ? 220 : 0);
      }

      markWordKnown(word) {
        this.lastAction = { word, prevStatus: word.status, prevStreak: word.streak, prevUpdatedAt: word.updatedAt, prevDueAt: word.dueAt, wasCorrect: true };

        // Progress the word's status
        if (!word.status || word.status === 'red') {
          // First time: red -> orange. Rest for ~4 hours before it's
          // eligible for a confirmation round again - real spaced
          // repetition, not an instant re-drill.
          word.status = 'orange';
          word.streak = 1;
          word.dueAt = Date.now() + 4 * 60 * 60 * 1000;
        } else if (word.status === 'orange') {
          // Second correct answer, after resting - now mastered.
          word.status = 'green';
          word.streak = 2;
          word.dueAt = null;

          // Structured mode: unlock the next level once every word in the
          // current level is mastered.
          if (this.levelProgression === 'structured') {
            const currentLevelWords = this.words.filter(w => w.difficulty === this.currentLevel);
            const allLevelMastered = currentLevelWords.every(w => w.status === 'green');
            if (allLevelMastered) {
              this.unlockNextLevel();
            }
          }
        }
        word.updatedAt = Date.now();

        this.sessionStats.correct++;
        this.allTimeStats.totalAttempts++;
        this.allTimeStats.totalCorrect++;
        this.saveProgress();
        this.render();
      }

      markWordUnknown(word) {
        const prevIndex = this.currentSession.indexOf(word);
        this.lastAction = { word, prevStatus: word.status, prevStreak: word.streak, prevUpdatedAt: word.updatedAt, prevDueAt: word.dueAt, wasCorrect: false, prevIndex };

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

        // Send the missed word to the back of this session's queue instead
        // of leaving it at the front - otherwise it would immediately come
        // back up as the next card. It still resurfaces later in the same
        // set, just after other words get a turn.
        if (prevIndex !== -1) {
          this.currentSession.splice(prevIndex, 1);
          this.currentSession.push(word);
        }

        this.sessionStats.incorrect++;
        this.allTimeStats.totalAttempts++;
        this.saveProgress();
        this.render();
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
        const summaryText = restingInSession === 0
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
                <div style="font-size: 2rem; font-weight: 600; color: var(--teal);">${overallStats.mastered} / 3500</div>
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
