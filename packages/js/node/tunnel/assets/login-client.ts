import {
  AUTH_BASE_PATH,
  beginPasskeySignIn,
  getAuthStatus,
  requestEmailOtp,
  type PasskeyOperation,
  verifyEmailOtp,
} from "@dbx-tools/shared-auth/client";

const emailForm = document.querySelector<HTMLFormElement>("#email-form")!;
const codeForm = document.querySelector<HTMLFormElement>("#code-form")!;
const emailInput = document.querySelector<HTMLInputElement>("#email")!;
const codeInput = document.querySelector<HTMLInputElement>("#code")!;
const emailSubmit = document.querySelector<HTMLButtonElement>("#email-submit")!;
const codeSubmit = document.querySelector<HTMLButtonElement>("#code-submit")!;
const passkeySubmit = document.querySelector<HTMLButtonElement>("#passkey-submit")!;
const back = document.querySelector<HTMLButtonElement>("#back")!;
const message = document.querySelector<HTMLDivElement>("#msg")!;

let email = "";
let passkeyOperation: PasskeyOperation | undefined;
let returnTo = document.body.dataset.returnTo || "/";

if (window.location.pathname !== AUTH_BASE_PATH) {
  returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function say(text: string, isError = false): void {
  message.textContent = text;
  message.className = `msg${isError ? " error" : ""}`;
}

function cancelPasskey(): void {
  const operation = passkeyOperation;
  passkeyOperation = undefined;
  operation?.cancel();
}

function redirectAfterSignIn(): void {
  say("Signed in. Loading.");
  window.location.replace(returnTo);
}

function startPasskey(autoFill: boolean): void {
  cancelPasskey();
  const operation = beginPasskeySignIn(autoFill);
  passkeyOperation = operation;
  void operation.result
    .then((authenticated) => {
      if (passkeyOperation !== operation) return;
      passkeyOperation = undefined;
      if (authenticated) {
        redirectAfterSignIn();
      } else if (!autoFill) {
        say("Unable to sign in with a passkey. Use email recovery instead.", true);
      }
    })
    .catch(() => {
      if (passkeyOperation !== operation) return;
      passkeyOperation = undefined;
      if (!autoFill) say("Unable to sign in with a passkey. Use email recovery instead.", true);
    });
}

void getAuthStatus()
  .then(async (status) => {
    if (status.authenticated) {
      redirectAfterSignIn();
      return;
    }
    if (!status.passkeysEnabled) return;
    passkeySubmit.hidden = false;
    if (
      typeof PublicKeyCredential === "undefined" ||
      typeof PublicKeyCredential.isConditionalMediationAvailable !== "function" ||
      !(await PublicKeyCredential.isConditionalMediationAvailable())
    ) {
      return;
    }
    startPasskey(true);
  })
  .catch(() => undefined);

passkeySubmit.addEventListener("click", () => {
  say("");
  startPasskey(false);
});

emailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  email = emailInput.value.trim();
  if (!email) return;
  cancelPasskey();
  emailSubmit.disabled = true;
  say("Sending.");
  void requestEmailOtp(email)
    .then((accepted) => {
      if (!accepted) throw new Error("OTP request failed");
      emailForm.classList.add("hidden");
      codeForm.classList.remove("hidden");
      codeInput.focus();
      say(`If ${email} is authorized, a verification code is on its way.`);
    })
    .catch(() => say("Could not send a code. Check the address and try again.", true))
    .finally(() => {
      emailSubmit.disabled = false;
    });
});

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!code) return;
  codeSubmit.disabled = true;
  say("Verifying.");
  void verifyEmailOtp(email, code, email.split("@")[0] || "User")
    .then((accepted) => {
      if (!accepted) throw new Error("OTP verification failed");
      redirectAfterSignIn();
    })
    .catch(() => {
      say("That code was not accepted. Try again.", true);
      codeSubmit.disabled = false;
    });
});

back.addEventListener("click", () => {
  codeForm.classList.add("hidden");
  emailForm.classList.remove("hidden");
  codeInput.value = "";
  say("");
  emailInput.focus();
});

window.addEventListener("pagehide", cancelPasskey, { once: true });
