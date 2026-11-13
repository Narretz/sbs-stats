// The "Front-line weather" checkbox among a page's secondary controls (inside
// MoreControls). The page owns the state (useWeatherStripPref) because it also
// decides whether to mount the strip at all.
export function WeatherToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      className="ctl ctl-check"
      title="Show how limited small drones were at each front-line direction (Open-Meteo model data)"
    >
      <input
        data-testid="weather-toggle"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      Front-line weather
    </label>
  );
}
