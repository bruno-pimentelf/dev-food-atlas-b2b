import { redirect } from "next/navigation";

export default function Home() {
  redirect("/conta/restaurants/list-restaurants")
}