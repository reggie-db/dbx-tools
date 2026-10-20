import { LakeboxPanel } from "@dbx-tools/ui-lakebox/react";

const Lakebox = () => (
  <div className="mx-auto h-full w-full max-w-4xl overflow-auto p-3 sm:p-4 md:p-6">
    <h1 className="sr-only">Lakebox</h1>
    <LakeboxPanel />
  </div>
);

export default Lakebox;
