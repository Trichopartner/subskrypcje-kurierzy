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
          1. Po utworzeniu zamówienia aplikacja wykrywa, czy dotyczy ono
          subskrypcji.
        </s-paragraph>
        <s-paragraph>
          2. Jeśli to kolejne zamówienie w kontrakcie, aplikacja pobiera metodę
          dostawy z pierwszego zamówienia.
        </s-paragraph>
        <s-paragraph>
          3. Następnie aktualizuje kontrakt subskrypcyjny tak, aby kolejne
          wysyłki używały tej samej metody.
        </s-paragraph>
        <s-paragraph>
          To eliminuje problem nadpisywania punktu InPost przez domyślną
          najtańszą metodę.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
