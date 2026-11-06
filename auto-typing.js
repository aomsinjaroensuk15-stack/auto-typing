// Source - https://codereview.stackexchange.com/q/148419
// Posted by Patrick Roberts, modified by community. See post 'Timeline' for change history
// Retrieved 2026-11-06, License - CC BY-SA 3.0

// ==UserScript==
// @name         Auto Typer
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automatically takes typing test in an infinite loop
// @author       Patrick Roberts
// @match        http://www.typingtest.com/test.html*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  // select the target node
  const container = document.querySelector('#test-container');

  // configure observer to look for added children
  const config = { childList: true };

  // create an observer instance
  const observer = new MutationObserver(verifyDependencies);

  // pass in the target node, as well as the observer options
  observer.observe(container, config);

  // check for existence of elements independently of mutations
  // in case mutations occurred before observer was initialized
  verifyDependencies();

  function verifyDependencies() {
    // get references to needed elements to check for existence after each mutation
    const textarea = container.querySelector('.test-text-area');
    const editor = container.querySelector('.test-edit-area');

    // wait to initialize when needed elements are in existence
    if (textarea !== null && editor !== null) {
      // pass references to textarea and editor
      initializeAutoTyper(textarea, editor);

      // disconnect observer to end callbacks
      observer.disconnect();
    }
  }

  function initializeAutoTyper(textarea, editor) {
    // formatted string from text area
    const text = textarea.textContent.replace(/\n| +(?= )/g, '').trim().replace(/\u21a9|$/g, '\r');
    // initialize iterator
    const iterator = typer(text, editor);
    // wait 0 ms between keystrokes
    const interval = 1;

    // typer generator function
    function* typer(text, editor) {
      // want non-lexical scoping to speed up iteration
      var i;

      // initialize properties
      const descriptor = {
        // use `detail` to avoid a scoped reference in the `keyCode` getter
        detail: {
          value: text
        },
        keyCode: {
          get: function getter() {
            return this.detail.charCodeAt(i);
          }
        }
      };

      // initialize re-useable events
      const down = new KeyboardEvent('keydown');
      const press = new KeyboardEvent('keypress');

      // use descriptor because simply assigning `keyCode` does not "stick"
      Object.defineProperties(down, descriptor);
      Object.defineProperties(press, descriptor);

      // loop the test infinitely
      while (true) {
        // iterate through test string
        for (i = 0; i < text.length; i++) {
          // keydown and keypress events automatically update necessary getters by assigning `i`
          editor.dispatchEvent(down);
          editor.dispatchEvent(press);

          // pause between events to allow for page reflow
          yield;
        }
      }
    }

    // focus then type
    editor.focus();
    setInterval(iterator.next.bind(iterator), interval);
  }
})();
