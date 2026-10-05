// The shipped CAM profiles are imported as text by the in-page mock.
declare module "*.toml" {
    const text: string;
    export default text;
}
