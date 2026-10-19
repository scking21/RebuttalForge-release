import type { Health } from "../api-types";
import type { Resource } from "../hooks";
import { Icon } from "./ui";

export function EnvBanner({ health, fixtures }: { health: Resource<Health>; fixtures: boolean }) {
  const h = health.data;
  return (
    <div className="env" role="region" aria-label="Environment">
      {fixtures && (
        <p className="env__item env__item--fixture">
          <Icon name="alert" />
          <strong>Fixture data.</strong> This page is not connected to the API.
        </p>
      )}
      {h?.simulator === true && (
        <p className="env__item env__item--sim">
          <strong>Local stand-in for the PayPal sandbox.</strong> Not real PayPal.
        </p>
      )}
      {h?.simulator === false && (
        <p className="env__item env__item--sandbox">
          <strong>PayPal sandbox</strong>
          <span className="env__url">{h.paypalBaseUrl}</span>
        </p>
      )}
      {h === undefined && health.loading && <p className="env__item">Checking environment</p>}
      {h === undefined && health.error !== undefined && (
        <p className="env__item env__item--error" role="alert">
          <Icon name="alert" />
          <strong>Environment unknown.</strong> {health.error}
        </p>
      )}
      {h?.testDouble === true && (
        <p className="env__item env__item--warn">
          <Icon name="alert" />
          <strong>Scripted test double.</strong> Recommendations are canned. No AI model is being called.
        </p>
      )}
      {h?.aiConfigured === true && h.testDouble !== true && h.aiModel && (
        <p className="env__item">
          <strong>AI configured:</strong> {h.aiProvider} / {h.aiModel}. Review every generated claim.
        </p>
      )}
      {h?.aiConfigured === false && h.testDouble !== true && (
        <p className="env__item env__item--warn">
          <Icon name="alert" />
          <strong>AI not configured</strong>
        </p>
      )}
    </div>
  );
}
