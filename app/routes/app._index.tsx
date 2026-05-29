import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  return (
    <s-page heading="Aplikacja dostawy InPost dla subskrypcji">
      <s-section heading="Do czego służy ta aplikacja">
        <s-paragraph>
          Ta aplikacja pilnuje, aby w zamówieniach subskrypcyjnych była używana
          ta sama metoda dostawy InPost co w pierwszym zamówieniu kontraktu.
        </s-paragraph>
        <s-paragraph>
          Dzięki temu klient nie traci preferowanego paczkomatu przy kolejnych
          odnowieniach subskrypcji.
        </s-paragraph>
      </s-section>

      <s-section heading="Jak to działa">
        <s-paragraph>
          1. Webhook Shopify (orders/create, orders/update) synchronizuje
          zamówienia subskrypcyjne Appstle w Shopify.
        </s-paragraph>
        <s-paragraph>
          2. Webhook Sellassist koryguje mapowanie subscription → kurier lub
          paczkomat na podstawie danych z Shopify.
        </s-paragraph>
        <s-paragraph>
          3. Dla paczkomatu uzupełniane są PickupPoint*; dla kuriera usuwane są
          błędne PickupPoint* i ustawiana właściwa metoda w Sellassist.
        </s-paragraph>
      </s-section>

      <s-section heading="Konfiguracja webhooka Sellassist">
        <s-paragraph>
          W Sellassist: Administracja → Automatyzacja → Akcje dla zamówień →
          Wywołaj URL (POST lub GET):
        </s-paragraph>
        <s-paragraph>
          {"{SHOPIFY_APP_URL}"}/webhooks/sellassist/{"{id_order}"}
        </s-paragraph>
        <s-paragraph>
          Zmienne środowiskowe: SELASSIST_ACCOUNT, SELASSIST_API_KEY,
          SHOPIFY_SHOP_DOMAIN, opcjonalnie SELASSIST_WEBHOOK_SECRET,
          SELASSIST_SHIPMENT_ID_KURIER, SELASSIST_SHIPMENT_ID_PACZKOMAT.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
