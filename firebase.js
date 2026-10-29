import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const productsRef = collection(db, "products");
const siteSettingsRef = doc(db, "siteSettings", "storefront");
let currentAdmin = null;
let cloudCatalogLoaded = false;

function productDocument(product) {
  const { id, ...fields } = product;
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

function firebaseMessage(error) {
  const code = error?.code || "";
  if (code === "auth/invalid-email" || code === "auth/missing-email") {
    return "صيغة البريد الإلكتروني غير صحيحة. اكتب البريد كاملًا.";
  }
  if (code === "auth/missing-password") {
    return "اكتب كلمة المرور قبل تسجيل الدخول.";
  }
  if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found"].includes(code)) {
    return "البريد الإلكتروني أو كلمة المرور غير صحيحين. راجع البيانات وحاول مرة أخرى.";
  }
  if (code === "auth/user-disabled") {
    return "هذا الحساب موقوف في Firebase. راجع حالة المستخدم في Authentication.";
  }
  if (code === "auth/too-many-requests") {
    return "محاولات الدخول كثيرة. انتظر قليلًا ثم حاول مرة أخرى.";
  }
  if (code === "auth/network-request-failed" || code === "unavailable") {
    return "تعذر الاتصال بـ Firebase. افحص الإنترنت ثم حاول مرة أخرى.";
  }
  if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") {
    return "تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في إعدادات Firebase.";
  }
  if (code === "auth/unauthorized-domain" || code === "auth/app-not-authorized") {
    return "رابط الموقع غير مضاف إلى النطاقات المصرح بها في Firebase Authentication.";
  }
  if (code === "permission-denied" || code === "firestore/permission-denied") {
    return "Firebase رفض قراءة أو حفظ البيانات. أعد نشر قواعد Firestore الموجودة في firestore.rules.";
  }
  if (code === "failed-precondition") {
    return "إعداد قاعدة Firestore غير مكتمل. راجع Firebase Console ثم حاول مرة أخرى.";
  }
  return "حصل خطأ أثناء الاتصال بـ Firebase" + (code ? ` (${code})` : ". حاول مرة أخرى.");
}

function throwFriendly(error) {
  if (error instanceof Error && !error.code) throw error;
  throw new Error(firebaseMessage(error));
}

onSnapshot(productsRef, (snapshot) => {
  if (snapshot.empty && !cloudCatalogLoaded) return;
  cloudCatalogLoaded = true;
  const products = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  window.shieldApplyCloudProducts?.(products);
}, (error) => {
  console.error("Could not load the public product catalog:", error);
});

onSnapshot(siteSettingsRef, (snapshot) => {
  window.shieldSiteSettingsError = null;
  window.shieldApplySiteSettings?.(snapshot.exists() ? snapshot.data() : {});
}, (error) => {
  window.shieldSiteSettingsError = error;
  console.error("Could not load public storefront settings:", error);
  if (currentAdmin) {
    window.shieldShowToast?.(firebaseMessage(error), "error");
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentAdmin = null;
    window.shieldAuthState?.(null);
    return;
  }

  try {
    const marker = await getDoc(doc(db, "admins", user.uid));
    if (marker.exists() && marker.data().role === "admin") {
      currentAdmin = user;
      window.shieldAuthState?.(user);
      return;
    }
    currentAdmin = null;
    await signOut(auth);
    window.shieldAuthState?.(null, "الحساب مسجل في Firebase لكنه غير مضاف كأدمن للموقع.");
  } catch (error) {
    console.error("Could not restore the admin session:", error);
    currentAdmin = null;
    window.shieldAuthState?.(null, firebaseMessage(error));
  }
});

window.shieldFirebaseReady = true;

window.shieldAdminLogin = async (email, password) => {
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    let marker;
    try {
      marker = await getDoc(doc(db, "admins", credential.user.uid));
    } catch (error) {
      await signOut(auth);
      throw new Error(firebaseMessage(error));
    }

    if (!marker.exists() || marker.data().role !== "admin") {
      await signOut(auth);
      throw new Error("البريد وكلمة المرور صحيحان، لكن هذا الحساب غير مسجل كأدمن للموقع. راجع مستند admins ورقم UID في Firestore.");
    }

    currentAdmin = credential.user;
    window.shieldAuthState?.(credential.user);

    // Catalog setup is separate from authentication so a catalog write failure
    // never hides a successful sign-in from the admin.
    try {
      const snapshot = await getDocs(productsRef);
      if (snapshot.empty) {
        const seedProducts = window.shieldGetProducts?.() || [];
        await Promise.all(seedProducts.map((product) =>
          setDoc(doc(db, "products", product.id), productDocument(product))
        ));
      }
    } catch (error) {
      console.error("Admin signed in, but the catalog could not be initialized:", error);
      window.shieldShowToast?.("تم تسجيل الدخول، لكن تعذر تجهيز المنتجات. راجع قواعد Firestore.", "error");
    }
    return credential.user;
  } catch (error) {
    if (error instanceof Error && !error.code) throw error;
    throwFriendly(error);
  }
};

window.shieldAdminLogout = async () => {
  currentAdmin = null;
  await signOut(auth);
};

window.shieldSaveProduct = async (product) => {
  if (!currentAdmin) throw new Error("سجّل دخول الأدمن أولًا.");
  try {
    await setDoc(doc(db, "products", product.id), productDocument(product));
  } catch (error) {
    throw new Error(firebaseMessage(error));
  }
};

window.shieldDeleteProduct = async (id) => {
  if (!currentAdmin) throw new Error("سجّل دخول الأدمن أولًا.");
  try {
    await deleteDoc(doc(db, "products", id));
  } catch (error) {
    throw new Error(firebaseMessage(error));
  }
};

window.shieldSaveSiteSettings = async (texts, colors) => {
  if (!currentAdmin) throw new Error("سجّل دخول الأدمن أولًا.");
  const colorKeys = ["accent", "primary", "background", "surface", "text", "muted", "border"];
  const validColors = colors && colorKeys.every((key) =>
    typeof colors[key] === "string" && /^#[0-9a-f]{6}$/i.test(colors[key])
  ) && Object.keys(colors).every((key) => colorKeys.includes(key));
  const validTexts = texts && typeof texts === "object" && !Array.isArray(texts)
    && Object.keys(texts).length <= 150
    && Object.entries(texts).every(([key, value]) =>
      typeof key === "string" && key.length <= 1000
      && typeof value === "string" && value.length <= 2000
    );
  const textsJson = JSON.stringify(texts);
  if (!validColors || !validTexts || typeof textsJson !== "string" || textsJson.length > 100000) {
    throw new Error("فيه نص أو لون غير صالح. راجع التعديلات وحاول مرة أخرى.");
  }
  try {
    await setDoc(siteSettingsRef, { textsJson, colors });
  } catch (error) {
    throw new Error(firebaseMessage(error));
  }
};
