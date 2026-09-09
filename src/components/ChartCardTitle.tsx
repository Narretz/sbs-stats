import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";

interface Props {
  title: string;
  /** Fragment id of the enclosing card; renders the "#" deep-link affordance. */
  anchor?: string;
  /** Cards differ in the gap below the title (4 / 6 / 14px). */
  marginBottom?: number;
}

// The heading shared by every chart card. Besides deduplicating markup that
// was copy-pasted across five components, this is where a chart's deep link
// lives: the title is an <a> to the card's own fragment, so clicking it puts a
// shareable URL in the address bar.
//
// The hover "#" is CSS generated content (`.chart-anchor::after` in styles/theme.css),
// NOT a DOM node. As a real element it joined the heading's textContent, so
// the title read "Mortars #" to anything matching on text — which broke
// `getByText(title, { exact: true })` in the e2e suite, and would equally have
// broken copy-paste and any future text lookup.
export function ChartCardTitle({ title, anchor, marginBottom = 4 }: Props) {
  const { theme: t } = useTheme();
  const style: React.CSSProperties = {
    fontFamily: FONTS.display, fontWeight: 700, fontSize: 12,
    color: t.textMuted, letterSpacing: "0.07em",
    textTransform: "uppercase", marginBottom,
  };

  if (!anchor) return <div style={style}>{title}</div>;

  return (
    <div style={style}>
      <a
        href={`#${anchor}`}
        className="chart-anchor"
        style={{ color: "inherit", textDecoration: "none" }}
        title="Link to this chart"
      >
        {title}
      </a>
    </div>
  );
}
